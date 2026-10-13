import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
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

test('binary path rỗng thì từ chối', () => {
  const bad = { ...GOOD, binaries: { codex: '' } };
  assert.throws(() => loadConfig(writeCfg(bad)), /must be an absolute path/);
});

test('provider openai không cần khai báo thì chấp nhận', () => {
  const cfg = loadConfig(writeCfg({
    binaries: { codex: '/bin/echo' },
    roles: {
      splitter: { runner: 'codex', provider: 'openai', model: 'gpt-4' },
      reviewer: { runner: 'codex', provider: 'openai', model: 'gpt-4' },
      coder: { runner: 'codex', provider: 'openai', model: 'gpt-4' },
    },
  }));
  assert.ok(cfg);
});

test('runner claude với provider lạ thì từ chối', () => {
  const bad = {
    ...GOOD,
    binaries: { codex: '/bin/echo', claude: '/bin/echo' },
    roles: { ...GOOD.roles, reviewer: { runner: 'claude', provider: 'unknown', model: 'sonnet' } },
  };
  assert.throws(() => loadConfig(writeCfg(bad)), /is not declared in providers/);
});

// --- Khoảng hở của schema: file này do người dùng gõ tay nên lỗi gõ phải kêu lên ---

test('khoá gõ sai ở mọi cấp bị từ chối, và thông báo gọi đúng tên khoá đó', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['gốc', { ...GOOD, maxRound: 5 }, /Unrecognized key: "maxRound"/],
    ['binaries', { ...GOOD, binaries: { codex: '/bin/echo', codx: '/bin/echo' } },
      /binaries: Unrecognized key: "codx"/],
    ['providers.<tên>',
      { ...GOOD, providers: { greennode: { baseUrl: 'https://x', apiKeyEnv: 'K', baseURL: 'z' } } },
      /providers\.greennode: Unrecognized key: "baseURL"/],
    ['roles', { ...GOOD, roles: { ...GOOD.roles, codr: GOOD.roles.coder } },
      /roles: Unrecognized key: "codr"/],
    ['roles.coder', { ...GOOD, roles: { ...GOOD.roles, coder: { ...GOOD.roles.coder, modle: 'x' } } },
      /roles\.coder: Unrecognized key: "modle"/],
    ['timeouts', { ...GOOD, timeouts: { coderr: 5 } }, /timeouts: Unrecognized key: "coderr"/],
  ];
  for (const [level, bad, want] of cases) {
    assert.throws(() => loadConfig(writeCfg(bad)), want, `cấp ${level}`);
  }
});

test('effort vẫn là khoá hợp lệ của vai — strict không được chặn nhầm khoá có thật', () => {
  const cfg = loadConfig(writeCfg({
    ...GOOD, roles: { ...GOOD.roles, reviewer: { ...GOOD.roles.reviewer, effort: 'xhigh' } },
  }));
  assert.equal(cfg.roles.reviewer.effort, 'xhigh');
});

test('provider là chuỗi rỗng thì từ chối thay vì lọt qua bước kiểm provider đã khai báo', () => {
  const bad = { ...GOOD, roles: { ...GOOD.roles, reviewer: { runner: 'codex', provider: '', model: 'm' } } };
  assert.throws(() => loadConfig(writeCfg(bad)), /roles\.reviewer\.provider/);
});

test('timeouts có trần 86400 giây — hạn khổng lồ làm Node kẹp timer khiến mọi lượt hết giờ ngay', () => {
  assert.equal(loadConfig(writeCfg({ ...GOOD, timeouts: { coder: 86400 } })).timeouts.coder, 86400);
  for (const key of ['splitter', 'reviewer', 'coder']) {
    assert.throws(
      () => loadConfig(writeCfg({ ...GOOD, timeouts: { [key]: 86401 } })),
      new RegExp(`timeouts\\.${key}`),
      `timeouts.${key} = 86401 phải bị từ chối`,
    );
  }
});

test('binary trỏ vào thư mục thì từ chối — existsSync nhận cả thư mục', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcg-bin-'));
  assert.throws(
    () => loadConfig(writeCfg({ ...GOOD, binaries: { codex: dir } })),
    /binaries\.codex is not a file/,
  );
});

test('binary là file nhưng không có quyền thực thi thì từ chối, cấp quyền rồi thì nhận', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcg-bin-'));
  const f = join(dir, 'codex');
  writeFileSync(f, '#!/bin/sh\n');
  chmodSync(f, 0o644);
  assert.throws(
    () => loadConfig(writeCfg({ ...GOOD, binaries: { codex: f } })),
    /binaries\.codex is not executable/,
  );
  // Cùng file, chỉ thêm quyền thực thi: chứng tỏ lần từ chối trên là do quyền chứ không do
  // lý do nào khác (đường dẫn sai, schema...).
  chmodSync(f, 0o755);
  assert.equal(loadConfig(writeCfg({ ...GOOD, binaries: { codex: f } })).binaries.codex, f);
});
