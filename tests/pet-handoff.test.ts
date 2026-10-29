import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLang, t } from '../web/src/i18n.ts';
import { canContinue, placeLabel, placeName } from '../web/src/pet/handoff.ts';
import type { Handoff } from '../web/src/types.ts';

const handoff = (o: Partial<Handoff>): Handoff => ({
  id: 'hf_1', session_id: 's', project_id: 'p', status: 'confirmed', source_revision: 1, confirmed_revision: 1, confirmed_at: 1,
  delivered_at: null, delivered_via: null, error: null, created_at: 0, updated_at: 0,
  project: { id: 'p', name: 'Citation model', workspace: '/tmp/citation-rag' }, meeting_project_id: 'p', project_mismatch: false, items: [],
  freshness: { current_revision: 1, reviewed_revision: 1, stale: false, detail: { new_transcript_lines: 0, new_outputs: 0, summary_regenerated: false, new_frames: 0, resumed: false, reassigned: false, meeting_deleted: false } },
  last_agent_read: null, ...o,
});

test('the pet continues only a confirmed handoff for the meeting’s current project', () => {
  assert.equal(canContinue(handoff({})), true);
  assert.equal(canContinue(handoff({ status: 'draft' })), false, 'reviewing stays in Chumi’s window');
  assert.equal(canContinue(handoff({ project: null })), false);
  assert.equal(canContinue(handoff({ project_mismatch: true })), false, 'moved to another project: review again first');
  assert.equal(canContinue(null), false);
  const stale = handoff({}); stale.freshness.stale = true;
  assert.equal(canContinue(stale), false, 'changed meetings need review in Chumi');
});

test('destinations are named as in Chumi’s Continue in menu, in its language', () => {
  setLang('zh');
  assert.equal(t(placeName('codex-app')), 'Codex app');
  assert.equal(t(placeName('codex')), '终端中的 Codex');
  assert.equal(t('Continue the handoff in {place}', { place: t(placeName('claude-code')) }), '继续这份交接：终端中的 Claude Code');
  assert.equal(t(placeLabel('copy')), '交接');
  setLang('en');
  assert.equal(placeLabel('codex'), 'Codex');
  assert.equal(placeLabel('qwen-code'), 'Qwen Code');
  assert.equal(placeName('opencode'), 'opencode');
  assert.equal(placeLabel('deepseek-harness'), 'DeepSeek Harness');
  setLang('zh');
  assert.equal(t('Opened {agent} and copied a one-line instruction. Open the project folder there, start a new session and paste it.', { agent: placeName('deepseek-harness') }),
    '已打开 DeepSeek Harness，并复制了一行指令。请在那里打开项目文件夹，新建会话后粘贴。');
  setLang('en');
});
