import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { runRole, ensureGuardHome, GUARD_RULES, type RunResult } from '../src/runner.ts';

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

test('ensureGuardHome thay file rules bằng rename chứ không cắt cụt tại chỗ', () => {
  const root = mkdtempSync(join(tmpdir(), 'mcg-g-'));
  const home = ensureGuardHome(root);
  const rules = join(home, 'rules', 'guard.rules');
  const inoBefore = statSync(rules).ino;
  ensureGuardHome(root);
  // Ghi đè tại chỗ giữ nguyên inode — và có một khoảnh khắc file rỗng cho codex con đang đọc
  // thấy, tức lớp lá chắn execpolicy biến mất không dấu vết. Rename thì cho ra inode mới.
  assert.notEqual(statSync(rules).ino, inoBefore, 'file bị ghi đè tại chỗ, không phải thay bằng rename');
  assert.equal(readFileSync(rules, 'utf8'), GUARD_RULES);
  // Không để rác: tệp tạm đã được đổi tên đi, và không bao giờ nằm trong rules/ (nơi codex quét).
  assert.deepEqual(readdirSync(join(home, 'rules')), ['guard.rules']);
  assert.deepEqual(readdirSync(home).filter((f) => f.endsWith('.tmp')), []);
});

test('runRole đọc được lastMessage từ file -o', async () => {
  chmodSync(FAKE, 0o755);
  const { cfg, dir } = cfgWith();
  const out = join(dir, 'last.txt');
  process.env.FAKE_LAST_MESSAGE = '{"tasks":[]}';
  try {
    const r = await runRole('splitter', cfg, {
      prompt: 'xin chao', cwd: dir, guardHome: ensureGuardHome(dir), outFile: out,
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
    assert.equal(r.lastMessage, '{"tasks":[]}');
  } finally {
    delete process.env.FAKE_LAST_MESSAGE;
  }
});

test('exit khác 0 được báo lại trung thực', async () => {
  chmodSync(FAKE, 0o755);
  const { cfg, dir } = cfgWith();
  process.env.FAKE_EXIT = '3';
  try {
    const r = await runRole('coder', cfg, {
      prompt: 'x', cwd: dir, guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
    });
    assert.equal(r.exitCode, 3);
  } finally {
    delete process.env.FAKE_EXIT;
  }
});

test('quá giờ thì bị giết và đánh dấu timedOut', async () => {
  chmodSync(FAKE, 0o755);
  const { cfg, dir } = cfgWith({ timeouts: { splitter: 1, reviewer: 1, coder: 1 } });
  process.env.FAKE_SLEEP = '5';
  try {
    const started = Date.now();
    const r = await runRole('coder', cfg, {
      prompt: 'x', cwd: dir, guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
    });
    const elapsed = Date.now() - started;
    assert.equal(r.timedOut, true);
    // Cuộc đua cũ (SIGKILL hạ `sleep` trước, `sh` kịp chạy `exit 0`) đã biến mất nhờ
    // `exec sleep` trong fixture: giờ con trực tiếp CHÍNH LÀ sleep, không còn shell để
    // thức dậy. Đo lại: 0/100 lần đỏ. Giữ assertion này vì nó ghim họ mutant `code ?? 0`.
    assert.equal(r.exitCode, -1, 'phải bị giết, không được tự thoát 0');
    assert.ok(elapsed < 3000, `hạn 1s mà settle mất ${elapsed}ms`);
  } finally {
    delete process.env.FAKE_SLEEP;
  }
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
  try {
    await runRole(role, loadConfig(p), {
      prompt: 'xin chao', cwd: dir, guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
    });
  } finally {
    delete process.env.RECORD_TO;
  }
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

test('provider openai dựng sẵn thì không sinh cờ -c model_provider nào', async () => {
  const { argv } = await argvOf('coder', null);
  // `-c approval_policy` vẫn phải có (con headless không được treo chờ phê duyệt),
  // nhưng KHÔNG được sinh cờ provider nào cho openai dựng sẵn.
  assert.ok(!argv.some((a) => a.includes('model_provider')), 'không được khai lại provider openai');
  assert.equal(argv[argv.indexOf('-m') + 1], 'm2');
});

test('mọi vai đều chạy approval_policy=never — con headless không treo chờ phê duyệt', async () => {
  for (const role of ['splitter', 'reviewer', 'coder'] as const) {
    const { argv } = await argvOf(role, 'gn');
    assert.ok(
      argv.includes('approval_policy="never"'),
      `vai ${role} thiếu approval_policy="never" — sẽ treo chờ Approve đến hết timeout`,
    );
    // Cờ này không được đi kèm --approve-for-me: flag đó xung đột với -s và làm CLI hỏng ngay.
    assert.ok(!argv.includes('--approve-for-me'));
  }
});

test('chỉ vai workspace-write được cấp network, vai read-only thì không', async () => {
  for (const [role, want] of [['coder', true], ['splitter', false], ['reviewer', false]] as const) {
    const { argv } = await argvOf(role, 'gn');
    const has = argv.includes('sandbox_workspace_write.network_access=true');
    assert.equal(has, want, `vai ${role}`);
    if (!want) {
      // network_access chỉ hợp lệ dưới sandbox workspace-write; ghim cả việc nó vắng mặt
      assert.ok(!argv.some((a) => a.includes('network_access')), `vai ${role} không được có network_access`);
    }
  }
});

test('CODEX_HOME trỏ guard home, PATH được nối thêm chứ không thay thế', async () => {
  const { body } = await argvOf('coder', 'gn');
  assert.match(body, /CODEX_HOME=.*codex-home/);
  assert.ok(!/CODEX_HOME=[^\n]*\/\.codex$/.test(body), 'không được trỏ vào ~/.codex của người dùng');
  const path = body.split('PATH=')[1].split('\n')[0];
  assert.ok(path.startsWith(process.env.PATH ?? ''), 'PATH cha phải còn nguyên ở đầu');
  // KHÔNG dùng includes('/usr/bin'): PATH cha thường đã có sẵn /usr/bin nên phép đó xanh kể cả
  // khi runner chẳng nối thêm gì. Phải khẳng định chính cái đuôi được nối vào.
  assert.ok(
    path.endsWith(':/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin'),
    `PATH con không kết thúc bằng các thư mục chuẩn được nối thêm: ${path}`,
  );
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
  try {
    await runRole('splitter', loadConfig(p), {
      prompt: 'xin chao', cwd: dir, guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
    });
  } finally {
    delete process.env.RECORD_TO;
  }
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
  // Phải dùng child KHÔNG ghi -o, nếu không fixture sẽ ghi đè và test xanh kể cả khi
  // bỏ rmSync — tức là chẳng ghim được gì.
  process.env.FAKE_NO_WRITE = '1';
  process.env.FAKE_EXIT = '1';
  try {
    const r = await runRole('coder', cfg, {
      prompt: 'x', cwd: dir, guardHome: ensureGuardHome(dir), outFile: out,
    });
    assert.equal(r.lastMessage, '', 'phải rỗng, không được là kết quả lượt trước');
  } finally {
    delete process.env.FAKE_NO_WRITE;
    delete process.env.FAKE_EXIT;
  }
});

test('văn bản tiếng Việt dài không bị hỏng ở ranh giới chunk', async () => {
  chmodSync(FAKE, 0o755);
  const { cfg, dir } = cfgWith();
  process.env.FAKE_BIG_UTF8 = '5000'; // ~305KB thật, vượt nhiều lần ngưỡng chunk 64KB
  try {
    const r = await runRole('coder', cfg, {
      prompt: 'x', cwd: dir, guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
    });
    assert.ok(r.stdout.length > 100000, `chỉ nhận được ${r.stdout.length} ký tự`);
    assert.ok(!r.stdout.includes('�'), 'có ký tự hỏng — decode từng chunk rời');
    assert.ok(!r.stderr.includes('�'), 'stderr cũng phải setEncoding');
    assert.match(r.stdout, /ăâêôơưđ ÀÁẠẢÃ/);
  } finally {
    delete process.env.FAKE_BIG_UTF8;
  }
});

// Hai test dưới đây KHÔNG cùng loại — đừng đọc chúng như một lời bảo đảm chung:
//  - Test 1 ghim tính chất an toàn thật: cháu NẰM TRONG nhóm tiến trình bị giết cùng cha khi
//    hết giờ. Thiếu nó, bỏ `detached` hay đổi process.kill(-pid) về child.kill() sẽ không
//    làm đỏ bất cứ thứ gì.
//  - Test 2 chỉ ghim việc runRole TRẢ VỀ đúng hạn dù có một cháu giữ pipe. Nó KHÔNG chứng minh
//    cháu bị giết, và thực tế là không: cháu tự `setsid` thoát nhóm thì sống sót (`sleep 8` của
//    fixture vẫn chạy sau khi test kết thúc), pipeline chỉ bỏ pipe phía mình chứ không đợi nó.
//    Một tác vụ của coder mà đẻ tiến trình nền TỰ tách khỏi nhóm (dev server tự daemon hoá,
//    `setsid ...`, test watcher tự tách) có thể để lại tiến trình đó — README mục Safety model
//    nói thẳng điều này. (Chỉ `&` thì chưa đủ: job nền của một shell không tương tác vẫn nằm
//    trong nhóm của nó nên vẫn bị giết.)

test('quá giờ thì giết cả NHÓM — cháu trong nhóm không được sống sót', async () => {
  chmodSync(FAKE, 0o755);
  // Hạn 5s chứ không phải 1s: dưới tải, fixture có thể chưa kịp ghi pid của cháu thì đã
  // bị SIGKILL, và test đỏ vì ENOENT chứ không phải vì group kill hỏng. Cháu ngủ 30s nên
  // 5s vẫn phân biệt được rõ giết-theo-nhóm với không giết.
  const { cfg, dir } = cfgWith({ timeouts: { splitter: 5, reviewer: 5, coder: 5 } });
  const pidFile = join(dir, 'gc.pid');
  process.env.FAKE_GRANDCHILD_PIDFILE = pidFile;
  const started = Date.now();
  let pid = 0;
  let r: RunResult;
  try {
    const pending = runRole('coder', cfg, {
      prompt: 'x', cwd: dir, guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
    });

    // Đọc pid NGAY khi fixture ghi ra, song song với lượt chạy — đọc sau khi runRole kết
    // thúc là đọc một file mà tiến trình đã bị giết có thể chưa kịp tạo.
    const readBy = Date.now() + 20_000;
    while (Date.now() < readBy && pid <= 0) {
      if (existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8').trim()) || 0;
      if (pid <= 0) await new Promise((res) => setTimeout(res, 20));
    }
    r = await pending;
  } finally {
    delete process.env.FAKE_GRANDCHILD_PIDFILE;
  }

  assert.ok(pid > 0, 'fixture không ghi được pid của cháu');
  assert.equal(r.timedOut, true);
  // Nới từ 3s lên 15s: cháu ngủ 30s, nên ngưỡng này vẫn đỏ khi group kill hỏng, mà
  // không đỏ oan chỉ vì máy đang bận.
  assert.ok(Date.now() - started < 15_000, `settle mất ${Date.now() - started}ms`);

  // Poll chờ ESRCH thay vì ngủ cứng 300ms: kernel dọn nhanh hay chậm tuỳ tải.
  let gone = false;
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
    } catch {
      gone = true;
      break;
    }
    await new Promise((res) => setTimeout(res, 20));
  }
  if (!gone) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* dọn rác khi test đỏ */ }
  }
  assert.ok(gone, `cháu pid ${pid} còn sống — group kill hỏng, agent ghi file thành mồ côi`);
});

test('cháu tự thoát nhóm mà giữ pipe thì vẫn không kéo dài quá hạn (cháu đó KHÔNG bị giết)', async () => {
  chmodSync(FAKE, 0o755);
  const { cfg, dir } = cfgWith({ timeouts: { splitter: 1, reviewer: 1, coder: 1 } });
  process.env.FAKE_ESCAPED_NODE = process.execPath;
  try {
    const started = Date.now();
    const r = await runRole('coder', cfg, {
      prompt: 'x', cwd: dir, guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
    });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - started < 3000, 'huỷ pipe phía ta không hoạt động');
  } finally {
    delete process.env.FAKE_ESCAPED_NODE;
  }
});
