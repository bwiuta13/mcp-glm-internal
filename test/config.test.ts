import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ROLE_SANDBOX } from '../src/config.ts';

function writeCfg(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcg-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

const GOOD = {
  binaries: { codex: '/bin/echo' },
  providers: { greennode: { baseUrl: 'https://x/v1', apiKeyEnv: 'GN_KEY' } },
  roles: {
    splitter: { runner: 'codex', provider: 'greennode', model: 'z-ai/glm-5.3' },
    reviewer: { runner: 'codex', provider: 'greennode', model: 'z-ai/glm-5.3' },
    coder: { runner: 'codex', provider: 'greennode', model: 'z-ai/glm-5.3' },
  },
};

test('sandbox của mỗi vai là cố định', () => {
  assert.equal(ROLE_SANDBOX.coder, 'workspace-write');
  assert.equal(ROLE_SANDBOX.splitter, 'read-only');
  assert.equal(ROLE_SANDBOX.reviewer, 'read-only');
});

test('config hợp lệ thì áp mặc định', () => {
  const cfg = loadConfig(writeCfg(GOOD));
  assert.equal(cfg.maxRounds, 3);
  assert.equal(cfg.snapshotUntracked, false);
  assert.equal(cfg.timeouts.coder, 900);
  assert.equal(cfg.providers.greennode.wireApi, 'responses');
});

test('thiếu file thì báo đường dẫn', () => {
  assert.throws(() => loadConfig('/khong/ton/tai.json'), /Config not found/);
});

test('JSON hỏng thì nói rõ là JSON hỏng', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcg-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, '{ hỏng');
  assert.throws(() => loadConfig(p), /not valid JSON/);
});

test('đường dẫn binary tương đối bị từ chối', () => {
  const bad = { ...GOOD, binaries: { codex: 'codex' } };
  assert.throws(() => loadConfig(writeCfg(bad)), /must be an absolute path/);
});

test('binary không tồn tại trên đĩa thì từ chối', () => {
  const bad = { ...GOOD, binaries: { codex: '/khong/co/codex' } };
  assert.throws(() => loadConfig(writeCfg(bad)), /not found on disk/);
});

test('khai runner claude mà không khai binaries.claude thì từ chối', () => {
  const bad = { ...GOOD, roles: { ...GOOD.roles, reviewer: { runner: 'claude', model: 'sonnet' } } };
  assert.throws(() => loadConfig(writeCfg(bad)), /binaries\.claude is not configured/);
});

test('provider lạ thì từ chối', () => {
  const bad = { ...GOOD, roles: { ...GOOD.roles, coder: { runner: 'codex', provider: 'khongco', model: 'm' } } };
  assert.throws(() => loadConfig(writeCfg(bad)), /is not declared in providers/);
});

test('coder không phải runner codex thì từ chối', () => {
  const bad = {
    ...GOOD,
    binaries: { codex: '/bin/echo', claude: '/bin/echo' },
    roles: { ...GOOD.roles, coder: { runner: 'claude', model: 'sonnet' } },
  };
  assert.throws(() => loadConfig(writeCfg(bad)), /roles\.coder\.runner must be "codex"/);
});
