"""Checks the Chumi source inside a mybot checkout.

    python3 integrations/mybot/test_chumi_source.py <mybot-checkout> <chumi-export-dir>
"""
import json
import os
import sys

mybot, export_dir = sys.argv[1], sys.argv[2]
sys.path.insert(0, mybot)

from sources.chumi import ChumiSourceAdapter, read_header  # noqa: E402
from sources.registry import list_source_names  # noqa: E402
from sources.trajectory_lookup import read_events_for_session, read_payload_from_file  # noqa: E402

assert "chumi" in list_source_names(), list_source_names()
files = [f for f in os.listdir(export_dir) if f.endswith(".jsonl")]
assert files, "no exports found"
adapter = ChumiSourceAdapter(base_dir=export_dir)
sessions = adapter.discover_sessions()
assert len(sessions) == len([f for f in files if read_header(os.path.join(export_dir, f))]), (len(sessions), len(files))
s = sessions[0]
print(f"{len(sessions)} Chumi session(s) indexed; newest: {s.title!r}, {len(s.turns)} turns, updated {s.updated_at}")
assert s.source_name == "chumi" and s.turns and s.turns[0].role in ("user", "actions")
speech = [t for t in s.turns if t.role == "user"]
assert speech and speech[0].text.startswith("["), speech[0].text
private = [x for x in sessions if x.metadata.get("visibility") == "private"]
print(f"owner-only (private): {len(private)}/{len(sessions)}")

records = adapter.to_export_records(actor_id="owner")
kinds = sorted({r.record_kind for r in records})
print(f"import records: {len(records)} ({', '.join(kinds)})")
assert any(r.record_kind == "session" for r in records)
assert all(r.metadata.get("visibility") == s2.metadata.get("visibility") for r in records if r.record_kind == "session" for s2 in sessions if r.source_ref == f"chumi:{s2.session_id}")

events = read_events_for_session(s)
assert events and events[0].role in ("user", "actions"), events[:1]
payload = read_payload_from_file(source_name="chumi", source_ref=f"chumi:{s.session_id}", session_id=s.session_id, title=s.title,
                                 updated_at=s.updated_at, cwd="", file_path=s.file_path, metadata=s.metadata, query="barcode")
assert payload and payload["total_events"] == len(events), payload and payload["total_events"]
print(f"windowed read: {payload['total_events']} events, {len(payload['snippets'])} snippet(s) for 'barcode'")
if payload["snippets"]:
    print("  e.g.", payload["snippets"][0][:160].replace("\n", " | "))
print("OK")
