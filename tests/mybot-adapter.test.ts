import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Minimal mybot models keep the adapter test independent of a local mybot checkout.
const harness = `
import glob, importlib.util, json, os, sys, tempfile, types
from types import SimpleNamespace
for name in ['sources', 'sources.access', 'sources.common', 'sources.models']:
    sys.modules[name] = types.ModuleType(name)
class Account:
    def __init__(self, **kwargs): self.__dict__.update(kwargs)
    @property
    def expanded_base_dir(self): return self.base_dir
    def scoped_session_id(self, sid): return sid
    def include_session(self, sid, raw): return True
class Model:
    def __init__(self, **kwargs): self.__dict__.update(kwargs)
def recent_files(patterns, limit):
    paths = sorted([p for pattern in patterns for p in glob.glob(pattern)], key=os.path.getmtime, reverse=True)
    return paths[:limit] if limit else paths
sys.modules['sources.access'].TrajectoryAccessAccount = Account
sys.modules['sources.common'].recent_files = recent_files
models = sys.modules['sources.models']
models.NormalizedTrajectory = models.NormalizedTurn = models.TrajectorySourceAdapter = Model
models.normalize_text = lambda text, limit: text[:limit]
spec = importlib.util.spec_from_file_location('sources.chumi', 'integrations/mybot/chumi.py')
chumi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chumi)
`;

function python(script: string) {
  return execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', harness + script], { encoding: 'utf8' });
}

test('mybot selects 200 newest meeting dates even when 350 exports have reversed mtimes', () => {
  assert.equal(python(`
with tempfile.TemporaryDirectory() as directory:
    for i in range(350):
        path = os.path.join(directory, str(i) + '.jsonl')
        date = '2026-01-01T00:%02d:%02d.000Z' % divmod(i, 60)
        header = dict(type='session', format=chumi.FORMAT, id=str(i), started_at=date)
        if i % 2: header['ended_at'] = date
        with open(path, 'w') as handle:
            handle.write(json.dumps(header) + '\\n')
            handle.write(json.dumps(dict(type='segment', text='Meeting evidence', timestamp=date)) + '\\n')
        os.utime(path, (1000 - i, 1000 - i))
    adapter = chumi.ChumiSourceAdapter(directory)
    sessions = adapter.discover_sessions()
    assert [int(s.session_id) for s in sessions] == list(range(349, 149, -1))
    assert len(adapter.discover_sessions(0)) == 350
print('ok')
`).trim(), 'ok');
});

test('mybot labels handoffs whose meeting changed since review', () => {
  assert.equal(python(`
with tempfile.TemporaryDirectory() as directory:
    path = os.path.join(directory, 'meeting.jsonl')
    for stale in [False, True]:
        with open(path, 'w') as handle:
            handle.write(json.dumps(dict(type='handoff', freshness=dict(stale=stale), items=[dict(kind='action', text='Review evidence')])) + '\\n')
        text = list(chumi.iter_chumi_events(path))[0][1]
        assert ('changed since review' in text) == stale
        assert ('Confirmed meeting handoff' in text) != stale
print('ok')
`).trim(), 'ok');
});
