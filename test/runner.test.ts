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
  // Neo theo dòng, không dùng cờ /s: `.*` vắt qua xuống dòng sẽ khớp chữ "forbidden"
  // của rule kế bên, nên hạ rule commit xuống "allow" mà test vẫn xanh.
  assert.match(body, /^prefix_rule\(pattern=\["git","commit"\], decision="forbidden"/m);
  assert.match(body, /^prefix_rule\(pattern=\["git","push"\], decision="forbidden"/m);
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
  const started = Date.now();
  const r = await runRole('coder', cfg, {
    prompt: 'x', cwd: dir, guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
  });
  const elapsed = Date.now() - started;
  delete process.env.FAKE_SLEEP;
  assert.equal(r.timedOut, true);
  // Không khẳng định hai điều này thì xoá hẳn lệnh kill đi test vẫn xanh.
  assert.equal(r.exitCode, -1, 'tiến trình con phải bị giết, không được tự thoát 0');
  assert.ok(elapsed < 3000, `hạn 1s mà settle mất ${elapsed}ms — cháu còn giữ pipe`);
});

// --- Ghim argv và env an toàn: đây là chỗ mutation testing cho thấy hổng nhất ---

const RECORD = resolve(import.meta.dirname, 'fixtures/record-exec.sh');

async function argvOf(role: 'splitter' | 'reviewer' | 'coder', provider: string | null) {
  chmodSync(RECORD, 0o755);
  const dir = mkdtempSync(join(tmpdir(), 'mcg-rec-'));
  const p = join(dir, 'config.json');
  const roleCfg = (m: string) =>
    provider ? { runner: 'codex', provider, model: m } : { runner: 'codex', model: m };
  writeFileSync(p, JSON.stringify({
    binaries: { codex: RECORD },
    providers: { gn: { baseUrl: 'https://x/v1', apiKeyEnv: 'GN_KEY' } },
    roles: { splitter: roleCfg('m1'), reviewer: roleCfg('m1'), coder: roleCfg('m2') },
  }));
  const rec = join(dir, 'rec.txt');
  process.env.RECORD_TO = rec;
  await runRole(role, loadConfig(p), {
    prompt: 'xin chao', cwd: dir, guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
  });
  delete process.env.RECORD_TO;
  const body = readFileSync(rec, 'utf8');
  const argv = body.split('ARGV_BEGIN\n')[1].split('\nARGV_END')[0].split('\n');
  return { argv, body };
}

test('coder chạy workspace-write, splitter và reviewer chạy read-only', async () => {
  for (const [role, want] of [['coder', 'workspace-write'], ['splitter', 'read-only'],
                              ['reviewer', 'read-only']] as const) {
    const { argv } = await argvOf(role, 'gn');
    assert.equal(argv[argv.indexOf('-s') + 1], want, `vai ${role}`);
    assert.ok(!argv.includes('danger-full-access'), 'danger-full-access gỡ CẢ HAI lớp lá chắn');
  }
});

test('provider tuỳ chỉnh luôn khai wire_api responses và đủ bốn khoá', async () => {
  const { argv } = await argvOf('coder', 'gn');
  assert.ok(argv.includes('model_providers.gn.wire_api="responses"'));
  assert.ok(!argv.some((a) => a.includes('wire_api="chat"')), 'chat đã bị Codex gỡ bỏ');
  for (const k of ['name', 'base_url', 'env_key']) {
    assert.ok(argv.some((a) => a.startsWith(`model_providers.gn.${k}=`)), `thiếu ${k}`);
  }
  assert.ok(argv.includes('model_provider="gn"'));
});

test('provider openai dựng sẵn thì không sinh cờ -c nào', async () => {
  const { argv } = await argvOf('coder', null);
  assert.ok(!argv.includes('-c'));
  assert.equal(argv[argv.indexOf('-m') + 1], 'm2');
});

test('CODEX_HOME trỏ guard home, PATH được nối thêm chứ không thay thế', async () => {
  const { body } = await argvOf('coder', 'gn');
  assert.match(body, /CODEX_HOME=.*codex-home/);
  assert.ok(!/CODEX_HOME=[^\n]*\/\.codex$/.test(body), 'không được trỏ vào ~/.codex của người dùng');
  const path = body.split('PATH=')[1].split('\n')[0];
  assert.ok(path.startsWith(process.env.PATH ?? ''), 'PATH cha phải còn nguyên ở đầu');
  assert.ok(path.includes('/usr/bin'), 'phải nối thêm thư mục chuẩn');
});

test('runner claude đặt prompt ngay sau -p để --tools không nuốt mất', async () => {
  chmodSync(RECORD, 0o755);
  const dir = mkdtempSync(join(tmpdir(), 'mcg-cl-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify({
    binaries: { codex: FAKE, claude: RECORD },
    roles: {
      splitter: { runner: 'claude', model: 'sonnet', effort: 'xhigh' },
      reviewer: { runner: 'claude', model: 'sonnet' },
      coder: { runner: 'codex', model: 'm' },
    },
  }));
  const rec = join(dir, 'rec.txt');
  process.env.RECORD_TO = rec;
  await runRole('splitter', loadConfig(p), {
    prompt: 'xin chao', cwd: dir, guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
  });
  delete process.env.RECORD_TO;
  const argv = readFileSync(rec, 'utf8').split('ARGV_BEGIN\n')[1].split('\nARGV_END')[0].split('\n');
  assert.equal(argv[0], '-p');
  assert.equal(argv[1], 'xin chao', 'prompt phải đứng ngay sau -p');
  assert.equal(argv[argv.length - 1], 'Read,Grep,Glob', '--tools biến thiên nên phải ở cuối');
  assert.ok(argv.includes('--effort') && argv.includes('xhigh'));
});

test('spawn hỏng thì resolve chứ không làm sập tiến trình MCP', async () => {
  const { cfg, dir } = cfgWith();
  const r = await runRole('coder', cfg, {
    prompt: 'x', cwd: join(dir, 'thu-muc-khong-ton-tai'),
    guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
  });
  assert.equal(r.exitCode, -1);
  assert.match(r.stderr, /ENOENT|spawn/i);
});

test('outFile của lượt trước bị xoá, không bị đọc nhầm thành kết quả lượt này', async () => {
  chmodSync(FAKE, 0o755);
  const { cfg, dir } = cfgWith();
  const out = join(dir, 'o.txt');
  writeFileSync(out, 'KET-QUA-CU');
  process.env.FAKE_EXIT = '1';
  const r = await runRole('coder', cfg, {
    prompt: 'x', cwd: dir, guardHome: ensureGuardHome(dir), outFile: out,
  });
  delete process.env.FAKE_EXIT;
  assert.ok(!r.lastMessage.includes('KET-QUA-CU'));
});
