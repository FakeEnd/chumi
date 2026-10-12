"""Chumi meeting transcripts as a mybot source (https://github.com/jzhoulab/mybot).

Chumi (a local listening companion for lab meetings, advisor 1:1s, lectures and seminars) can export each
finished session as one JSONL file in the ``chumi-transcript/1`` format. This adapter indexes that folder so
mybot can answer questions like "what did my advisor say about the holdout split?" with dates and links back
to the exact moment of the meeting.

Mapping:
  * speech lines        -> role "user"       (what people actually said; highest search weight)
  * Chumi summary / Q&A -> role "assistant"  (AI-written; lower weight, clearly labelled)
  * pauses / gaps       -> role "actions"

Privacy: meetings contain other people's words, so sessions are owner-only (``visibility: private``) unless
the Chumi user explicitly exported them as shared.
"""
from __future__ import annotations

import json
import os
from typing import Iterator

from .access import TrajectoryAccessAccount
from .common import recent_files
from .models import NormalizedTrajectory, NormalizedTurn, TrajectorySourceAdapter, normalize_text

FORMAT = "chumi-transcript/1"
DEFAULT_BASE_DIR = "~/Library/Application Support/Chumi/exports/mybot"
SESSION_TYPES = {
    "lab_meeting": "lab meeting",
    "advisor": "advisor 1:1",
    "lecture": "lecture",
    "wip": "WIP talk",
    "other": "conversation",
}


def _clock(ms: int | float | None) -> str:
    seconds = max(0, int((ms or 0) // 1000))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def iter_chumi_events(path: str) -> Iterator[tuple[str, str, str, dict]]:
    """Yield (role, text, iso_timestamp, raw) for every meaningful line of a Chumi export."""
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = entry.get("type")
            if kind == "segment":
                origin = " (computer audio)" if entry.get("source") == "system" else ""
                text = f"[{_clock(entry.get('t_ms'))}]{origin} {entry.get('text', '')}".strip()
                yield "user", text, str(entry.get("timestamp") or ""), entry
            elif kind == "summary":
                yield "assistant", f"Chumi final summary (AI-generated):\n{entry.get('text', '')}", str(entry.get("created_at") or ""), entry
            elif kind == "qa":
                question = entry.get("question") or entry.get("kind", "question")
                covered = ""
                if entry.get("covered_from_ms") is not None and entry.get("covered_to_ms") is not None:
                    covered = f" (covers {_clock(entry['covered_from_ms'])}-{_clock(entry['covered_to_ms'])})"
                yield "assistant", f"Chumi {entry.get('kind', 'answer')}{covered} for \"{question}\" (AI-generated):\n{entry.get('answer', '')}", str(entry.get("created_at") or ""), entry
            elif kind == "gap":
                yield "actions", f"[{_clock(entry.get('t_ms'))}] recording {entry.get('kind')}: {entry.get('detail') or ''}".strip(), str(entry.get("timestamp") or ""), entry
            elif kind == "handoff":
                labels = {"decision": "Decision", "action": "Action", "question": "Open question"}
                rows = [f"- {labels.get(i.get('kind'), 'Item')}: {i.get('text', '')}" + (f" (owner: {i['owner']})" if i.get("owner") else "") for i in entry.get("items") or []]
                if rows:
                    yield "assistant", "Confirmed meeting handoff (reviewed by the user):\n" + "\n".join(rows), str(entry.get("confirmed_at") or ""), entry


def read_header(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as handle:
            first = json.loads(handle.readline() or "{}")
    except (OSError, json.JSONDecodeError):
        return None
    return first if first.get("type") == "session" and str(first.get("format", "")).startswith("chumi-transcript/") else None


class ChumiSourceAdapter(TrajectorySourceAdapter):
    def __init__(self, base_dir: str | None = None, *, account: TrajectoryAccessAccount | None = None) -> None:
        account = account or TrajectoryAccessAccount(source_name="chumi", name="default", base_dir=base_dir or DEFAULT_BASE_DIR)
        if base_dir is not None:
            account.base_dir = base_dir
        super().__init__(account_name=account.name)
        self.account = account
        self.base_dir = account.expanded_base_dir

    def source_name(self) -> str:
        return "chumi"

    def discover_sessions(self, max_files: int = 200) -> list[NormalizedTrajectory]:
        sessions: list[NormalizedTrajectory] = []
        for path in recent_files([os.path.join(self.base_dir, "*.jsonl")], max_files):
            header = read_header(path)
            if not header:
                continue
            raw_session_id = str(header.get("id") or os.path.basename(path)[:-6])
            session_id = self.account.scoped_session_id(raw_session_id)
            if not self.account.include_session(session_id, raw_session_id):
                continue
            turns: list[NormalizedTurn] = []
            summary = ""
            last_ts = ""
            for role, text, ts, raw in iter_chumi_events(path):
                turns.append(NormalizedTurn(role=role, text=normalize_text(text, 800), timestamp=ts or None))
                if raw.get("type") == "summary":
                    summary = str(raw.get("text") or "")
                if ts and role == "user":
                    last_ts = ts
            speech = [turn.text for turn in turns if turn.role == "user"]
            if not speech:
                continue
            kind = normalize_text(str(header.get("session_type_name") or ""), 60) or SESSION_TYPES.get(str(header.get("session_type")), "conversation")
            started = str(header.get("started_at") or "")
            title = normalize_text(f"{header.get('title') or 'Chumi session'} ({kind}, {started[:10]})", 140)
            updated_at = str(header.get("ended_at") or last_ts or started)
            if summary:
                short_summary = normalize_text(summary, 260)
                detailed_summary = normalize_text(summary, 2400)
            else:
                short_summary = normalize_text(f"{kind.capitalize()} transcript. Opening: {speech[0]}", 260)
                detailed_summary = normalize_text(" ".join(speech[:12]), 2400)
            metadata = {
                "tool": "chumi",
                "account": self.account.name,
                "raw_session_id": raw_session_id,
                # The project folder the user assigned this meeting to (empty when unassigned).
                "cwd": str(((header.get("project") or {}).get("workspace")) or header.get("cwd") or ""),
                "project_id": (header.get("project") or {}).get("id"),
                "project": (header.get("project") or {}).get("name"),
                "origin": "meeting",
                "session_type": header.get("session_type"),
                "audio_source": header.get("audio_source"),
                "started_at": started,
                "duration_ms": header.get("duration_ms"),
            }
            if header.get("visibility", "private") != "shared":
                metadata["visibility"] = "private"
            sessions.append(
                NormalizedTrajectory(
                    source_name=self.source_name(),
                    session_id=session_id,
                    title=title,
                    file_path=path,
                    updated_at=updated_at,
                    turns=turns,
                    short_summary=short_summary,
                    detailed_summary=detailed_summary,
                    metadata=metadata,
                )
            )
        self._sessions = sorted(sessions, key=lambda session: session.updated_at, reverse=True)
        return self._sessions
