import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { runRole, ensureGuardHome, GUARD_RULES } from '../src/runner.ts';

const FAKE = resolve(import.meta.dirname, 'fixtures/fake-codex.sh');

function cfgWith(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcg-run-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify({
    binaries: { codex: FAKE },
    providers: { greennode: { baseUrl: 'https://x/v1', apiKeyEnv: 'GN_KEY' } },
    roles: {
      splitter: { runner: 'codex', provider: 'greennode', model: 'm1' },
      reviewer: { runner: 'codex', provider: 'greennode', model: 'm1' },
      coder: { runner: 'codex', provider: 'greennode', model: 'm2' },
    },
    ...extra,
  }));
  return { cfg: loadConfig(p), dir };
}

test('ensureGuardHome ghi đúng nội dung rules', () => {
  const home = ensureGuardHome(mkdtempSync(join(tmpdir(), 'mcg-g-')));
  const body = readFileSync(join(home, 'rules', 'guard.rules'), 'utf8');
  assert.equal(body, GUARD_RULES);
  assert.match(body, /"git","commit".*forbidden/s);
  assert.match(body, /"git","push".*forbidden/s);
});

test('runRole đọc được lastMessage từ file -o', async () => {
  chmodSync(FAKE, 0o755);
  const { cfg, dir } = cfgWith();
  const out = join(dir, 'last.txt');
  process.env.FAKE_LAST_MESSAGE = '{"tasks":[]}';
  const r = await runRole('splitter', cfg, {
    prompt: 'xin chao', cwd: dir, guardHome: ensureGuardHome(dir), outFile: out,
  });
  delete process.env.FAKE_LAST_MESSAGE;
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.lastMessage, '{"tasks":[]}');
});

test('exit khác 0 được báo lại trung thực', async () => {
  chmodSync(FAKE, 0o755);
  const { cfg, dir } = cfgWith();
  process.env.FAKE_EXIT = '3';
  const r = await runRole('coder', cfg, {
    prompt: 'x', cwd: dir, guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
  });
  delete process.env.FAKE_EXIT;
  assert.equal(r.exitCode, 3);
});

test('quá giờ thì bị giết và đánh dấu timedOut', async () => {
  chmodSync(FAKE, 0o755);
  const { cfg, dir } = cfgWith({ timeouts: { splitter: 1, reviewer: 1, coder: 1 } });
  process.env.FAKE_SLEEP = '5';
  const r = await runRole('coder', cfg, {
    prompt: 'x', cwd: dir, guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
  });
  delete process.env.FAKE_SLEEP;
  assert.equal(r.timedOut, true);
});
