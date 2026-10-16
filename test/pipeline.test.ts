import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createJob, releaseJob, cancelJob, readTail } from '../src/jobs.ts';
import { runPipeline } from '../src/pipeline.ts';
import { GUARD_RULES } from '../src/runner.ts';

const SCRIPTED = resolve(import.meta.dirname, 'fixtures/scripted-codex.sh');

// Gốc dữ liệu RIÊNG của file test này. createJob mặc định ghi vào ~/.mcp-coding-glm thật (đã
// để lại hơn 1000 thư mục job ở đó), và runPipeline suy guard home từ job.dir — nên chỉ cần
// truyền gốc tạm cho createJob là thư mục job, khoá lẫn guard home đều nằm trong cây tạm.
const ROOT = mkdtempSync(join(tmpdir(), 'mcg-pipe-root-'));

/** Mỗi lần gọi, binary giả lấy phản hồi kế tiếp từ danh sách trong FAKE_SCRIPT_DIR. */
function cfgWith(scriptDir: string, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcg-pipe-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify({
    binaries: { codex: SCRIPTED },
    providers: { gn: { baseUrl: 'https://x/v1', apiKeyEnv: 'GN_KEY' } },
    roles: {
      splitter: { runner: 'codex', provider: 'gn', model: 'm' },
      reviewer: { runner: 'codex', provider: 'gn', model: 'm' },
      coder: { runner: 'codex', provider: 'gn', model: 'm' },
    },
    timeouts: { splitter: 10, reviewer: 10, coder: 10 },
    ...extra,
  }));
  process.env.FAKE_SCRIPT_DIR = scriptDir;
  // Pipeline từ chối thư mục không phải git work tree, vì ở đó không có cách nào lùi lại.
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return { cfg: loadConfig(p), dir };
}

/** Chờ tới đúng lượt agent thứ `index` bắt đầu, rồi mới huỷ — chờ theo mốc thời gian
 *  là nguồn gốc của test đỏ ngẫu nhiên. */
async function cancelWhenCallStarts(sd: string, index: number, jobId: string) {
  const log = join(sd, 'calls.log');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(log) && readFileSync(log, 'utf8').split('CALL ').length - 1 > index) break;
    await new Promise((res) => setTimeout(res, 20));
  }
  cancelJob(jobId);
}

function scriptDir(responses: string[]): string {
  const d = mkdtempSync(join(tmpdir(), 'mcg-script-'));
  responses.forEach((r, i) => writeFileSync(join(d, `${i}.txt`), r));
  writeFileSync(join(d, 'counter'), '0');
  return d;
}

const ONE_TASK = JSON.stringify({
  tasks: [{ id: '1', title: 'lam viec', detail: 'd', files: ['a.ts'], acceptance: 'ok' }],
});
const PASS = JSON.stringify({ verdict: 'pass', issues: [], guidance: '' });
const FAIL = JSON.stringify({ verdict: 'fail', issues: [{ severity: 'blocker', message: 'thieu test' }], guidance: 'them test' });

test('dryRun chỉ chia task rồi dừng, không gọi coder', async () => {
  chmodSync(SCRIPTED, 0o755);
  const { cfg, dir } = cfgWith(scriptDir([ONE_TASK]));
  const job = createJob('ke hoach', dir, ROOT);
  await runPipeline(job, cfg, { dryRun: true });
  assert.equal(job.state, 'done');
  assert.equal(job.tasks.length, 1);
  assert.equal(job.tasks[0].state, 'pending');
  releaseJob(job);
});

test('review pass ngay vòng đầu thì task passed', async () => {
  chmodSync(SCRIPTED, 0o755);
  const { cfg, dir } = cfgWith(scriptDir([ONE_TASK, 'da code xong', PASS]));
  const job = createJob('ke hoach', dir, ROOT);
  await runPipeline(job, cfg);
  assert.equal(job.state, 'done');
  assert.equal(job.tasks[0].state, 'passed');
  assert.equal(job.tasks[0].round, 1);
  releaseJob(job);
});

test('mỗi task có mốc diff gốc; bật snapshotUntracked thì chép file chưa theo dõi', async () => {
  chmodSync(SCRIPTED, 0o755);
  const { cfg, dir } = cfgWith(scriptDir([ONE_TASK, 'code', PASS]), { snapshotUntracked: true });
  writeFileSync(join(dir, 'chua-theo-doi.txt'), 'noi dung');

  const job = createJob('ke hoach', dir, ROOT);
  await runPipeline(job, cfg);

  const taskDir = join(job.dir, 'task-1-1');
  assert.ok(existsSync(join(taskDir, 'baseline.tree')));
  assert.equal(
    readFileSync(join(taskDir, 'untracked-before', 'chua-theo-doi.txt'), 'utf8'),
    'noi dung',
  );
  releaseJob(job);
});

test('review fail hết maxRounds thì thành needs_human chứ không treo', async () => {
  chmodSync(SCRIPTED, 0o755);
  const { cfg, dir } = cfgWith(scriptDir([ONE_TASK, 'code', FAIL, 'code', FAIL]), { maxRounds: 2 });
  const job = createJob('ke hoach', dir, ROOT);
  await runPipeline(job, cfg);
  assert.equal(job.state, 'done');
  assert.equal(job.tasks[0].state, 'needs_human');
  assert.equal(job.tasks[0].round, 2);
  releaseJob(job);
});

// Ba test dưới đây huỷ ĐÚNG từng điểm await. Một test huỷ chung chung không ghim được
// gì: xoá riêng từng điểm chặn vẫn xanh, vì cuộc huỷ luôn rơi vào điểm còn lại.

async function cancelDuringCall(holdOn: number, script: string[]) {
  chmodSync(SCRIPTED, 0o755);
  const sd = scriptDir(script);
  const { cfg, dir } = cfgWith(sd);
  process.env.FAKE_HOLD_ON = String(holdOn);
  try {
    const job = createJob('ke hoach', dir, ROOT);
    const running = runPipeline(job, cfg);
    await cancelWhenCallStarts(sd, holdOn, job.id);
    await running;
    return { job, used: Number(readFileSync(join(sd, 'counter'), 'utf8').trim()) };
  } finally {
    delete process.env.FAKE_HOLD_ON;
  }
}

test('huỷ lúc splitter đang chạy thì dừng hẳn', async () => {
  const { job, used } = await cancelDuringCall(0, [ONE_TASK, 'code', PASS]);
  assert.equal(job.state, 'cancelled');
  assert.equal(used, 1, `đã gọi ${used} lượt — không được gọi thêm agent nào sau khi huỷ`);
  assert.equal(job.current, null);
  assert.deepEqual(job.tasks, [], 'chưa chia xong thì chưa có task nào');
});

test('huỷ lúc coder đang chạy thì không gọi reviewer', async () => {
  const { job, used } = await cancelDuringCall(1, [ONE_TASK, 'code', PASS]);
  assert.equal(job.state, 'cancelled');
  assert.equal(used, 2, `đã gọi ${used} lượt — reviewer không được chạy`);
  // `$task-stop` nói agent đã bị giết; status không được nói ngược lại là task còn đang code.
  assert.equal(job.current, null, 'job đã huỷ thì không còn task "hiện tại"');
  assert.equal(job.tasks[0].state, 'pending', 'task dở dang phải về pending, không kẹt ở coding');
});

test('huỷ lúc reviewer đang chạy thì không sang vòng mới', async () => {
  const { job, used } = await cancelDuringCall(2, [ONE_TASK, 'code', FAIL, 'code', PASS]);
  assert.equal(job.state, 'cancelled');
  assert.equal(used, 3, `đã gọi ${used} lượt — không được mở vòng code mới`);
  assert.equal(job.current, null, 'job đã huỷ thì không còn task "hiện tại"');
  assert.equal(job.tasks[0].state, 'pending', 'task dở dang phải về pending, không kẹt ở reviewing');
});

test('splitter hỏng thì thử đúng 3 lượt, không hơn không kém', async () => {
  chmodSync(SCRIPTED, 0o755);
  const sd = scriptDir(['rac', 'rac', 'rac', ONE_TASK]);
  const { cfg, dir } = cfgWith(sd);
  const job = createJob('ke hoach', dir, ROOT);
  await runPipeline(job, cfg);
  assert.equal(job.state, 'failed');
  assert.equal(
    Number(readFileSync(join(sd, 'counter'), 'utf8').trim()), 3,
    'phải dừng đúng ở lượt 3 — lượt 4 trong kịch bản là JSON hợp lệ, không được chạm tới',
  );
  releaseJob(job);
});

test('lý do reviewer từ chối được đưa vào prompt vòng sau', async () => {
  chmodSync(SCRIPTED, 0o755);
  const sd = scriptDir([ONE_TASK, 'code', FAIL, 'code', PASS]);
  const { cfg, dir } = cfgWith(sd);
  const job = createJob('ke hoach', dir, ROOT);
  await runPipeline(job, cfg);
  const coder = readFileSync(join(sd, 'calls.log'), 'utf8')
    .split('===').filter((b) => b.includes('Implement this task'));
  assert.equal(coder.length, 2, 'phải có đúng 2 lượt coder');
  assert.ok(!coder[0].includes('them test'), 'vòng 1 chưa có guidance');
  assert.ok(coder[1].includes('them test'), 'vòng 2 phải mang lý do từ chối của reviewer');
  releaseJob(job);
});

test('task chỉ TẠO FILE MỚI thì diff vẫn ghi lại được', async () => {
  chmodSync(SCRIPTED, 0o755);
  const sd = scriptDir([ONE_TASK, 'code', PASS]);
  const { cfg, dir } = cfgWith(sd);
  process.env.FAKE_TOUCH = join(dir, 'hoan-toan-moi.ts');
  try {
    const job = createJob('ke hoach', dir, ROOT);
    await runPipeline(job, cfg);
    const d = readFileSync(join(job.dir, 'task-1-1', 'round-1.diff'), 'utf8');
    // `git diff` trần trả 0 byte ở đúng ca này — reviewer bị bảo "no changes were made".
    assert.match(d, /hoan-toan-moi\.ts/, 'file mới phải có trong diff');
    assert.match(d, /noi dung moi/, 'nội dung file mới phải có trong diff');
    // Đối chứng cho test snapshot.failed bên dưới: chụp cây khoẻ thì KHÔNG được có sự kiện đó.
    assert.ok(
      !readTail(job, 200).some((l) => l.includes('"snapshot.failed"')),
      'chụp cây thành công mà vẫn ghi snapshot.failed',
    );
    releaseJob(job);
  } finally {
    delete process.env.FAKE_TOUCH;
  }
});

test('thư mục không phải git thì job failed ngay, không gọi agent nào', async () => {
  chmodSync(SCRIPTED, 0o755);
  const sd = scriptDir([ONE_TASK, 'code', PASS]);
  const { cfg, dir } = cfgWith(sd);
  rmSync(join(dir, '.git'), { recursive: true, force: true });
  const job = createJob('ke hoach', dir, ROOT);
  await runPipeline(job, cfg);
  assert.equal(job.state, 'failed');
  assert.match(job.error ?? '', /not a git work tree/);
  assert.equal(
    Number(readFileSync(join(sd, 'counter'), 'utf8').trim()), 0,
    'không có lưới an toàn thì không được chạy agent nào cả',
  );
  releaseJob(job);
});

test('splitter trả JSON hỏng 3 lần thì job failed', async () => {
  chmodSync(SCRIPTED, 0o755);
  const { cfg, dir } = cfgWith(scriptDir(['khong phai json', 'van khong phai', 'van the']));
  const job = createJob('ke hoach', dir, ROOT);
  await runPipeline(job, cfg);
  assert.equal(job.state, 'failed');
  assert.match(job.error ?? '', /split/i);
  releaseJob(job);
});

test('chụp cây SAU coder mà hỏng thì có sự kiện snapshot.failed, không im lặng', async () => {
  chmodSync(SCRIPTED, 0o755);
  const sd = scriptDir([ONE_TASK, 'code', PASS]);
  const { cfg, dir } = cfgWith(sd);
  // Coder xoá .git giữa chừng: lần chụp kiểm tra ban đầu và lần chụp mốc gốc đã thành công,
  // chỉ lần chụp sau coder hỏng. Trước đây round-1.diff ra rỗng, KHÔNG có sự kiện nào, và
  // reviewer bị bảo "(no changes were made)" — nên task đậu mà không dấu vết nào cho thấy
  // diff chưa từng được chụp.
  process.env.FAKE_BREAK_GIT = join(dir, '.git');
  try {
    const job = createJob('ke hoach', dir, ROOT);
    await runPipeline(job, cfg);
    const failed = readTail(job, 200).map((l) => JSON.parse(l)).filter((e) => e.type === 'snapshot.failed');
    assert.equal(failed.length, 1, 'phải có đúng một sự kiện snapshot.failed');
    assert.equal(failed[0].before, true, 'mốc gốc đã chụp được');
    assert.equal(failed[0].after, false, 'lần chụp sau coder là lần hỏng');
    assert.equal(failed[0].round, 1);
    assert.equal(readFileSync(join(job.dir, 'task-1-1', 'round-1.diff'), 'utf8'), '');
    releaseJob(job);
  } finally {
    delete process.env.FAKE_BREAK_GIT;
  }
});

test('plan quá dài bị cắt trước khi vào argv — cả lượt đầu lẫn lượt sửa — và có sự kiện', async () => {
  chmodSync(SCRIPTED, 0o755);
  // Lượt 1 trả rác để ép đi vào nhánh sửa: nhánh đó dựng lại SPLIT_PROMPT, nên cũng phải dùng
  // plan đã cắt chứ không phải job.plan gốc.
  const sd = scriptDir(['khong phai json', ONE_TASK]);
  const { cfg, dir } = cfgWith(sd);
  const job = createJob('HEAD-MARKER ' + 'a'.repeat(300_000) + ' TAIL-MARKER', dir, ROOT);
  await runPipeline(job, cfg, { dryRun: true });
  const log = readFileSync(join(sd, 'calls.log'), 'utf8');
  assert.equal(job.state, 'done');
  assert.equal(log.split('CALL ').length - 1, 2, 'phải có đúng hai lượt splitter');
  assert.equal(log.split('HEAD-MARKER').length - 1, 2, 'cả hai lượt đều phải mang phần đầu plan');
  assert.ok(!log.includes('TAIL-MARKER'), 'đuôi plan phải bị cắt ở CẢ HAI lượt');
  assert.equal(log.split('plan truncated:').length - 1, 2, 'cả hai lượt đều phải có ghi chú cắt bớt');
  assert.ok(log.length < 500_000, `calls.log dài ${log.length} — plan chưa bị cắt`);
  const ev = readTail(job, 200).map((l) => JSON.parse(l)).filter((e) => e.type === 'plan.truncated');
  assert.equal(ev.length, 1, 'ghi sự kiện đúng một lần, không phải mỗi lượt');
  assert.equal(ev[0].kept, 200_000);
  releaseJob(job);
});

test('plan ngắn thì đi nguyên vẹn, không có ghi chú cắt bớt', async () => {
  chmodSync(SCRIPTED, 0o755);
  const sd = scriptDir([ONE_TASK]);
  const { cfg, dir } = cfgWith(sd);
  const job = createJob('plan ngan TAIL-MARKER', dir, ROOT);
  await runPipeline(job, cfg, { dryRun: true });
  const log = readFileSync(join(sd, 'calls.log'), 'utf8');
  assert.match(log, /plan ngan TAIL-MARKER/);
  assert.ok(!log.includes('plan truncated'));
  assert.ok(!readTail(job, 200).some((l) => l.includes('"plan.truncated"')));
  releaseJob(job);
});

test('splitter treo quá hạn thì failed ngay với lý do timeout — không thử lại, không đổ cho JSON hỏng', async () => {
  chmodSync(SCRIPTED, 0o755);
  const sd = scriptDir([ONE_TASK]);
  const { cfg, dir } = cfgWith(sd, { timeouts: { splitter: 1, reviewer: 10, coder: 10 } });
  process.env.FAKE_HOLD_ON = '0';
  try {
    const job = createJob('ke hoach', dir, ROOT);
    await runPipeline(job, cfg);
    assert.equal(job.state, 'failed');
    assert.match(job.error ?? '', /timed out after 1s/);
    assert.doesNotMatch(job.error ?? '', /valid JSON/, 'chẩn đoán sai: agent không trả lời, chứ không trả JSON hỏng');
    // Đếm bằng sự kiện của CHÍNH pipeline, không đếm bằng bộ đếm của fixture: trên máy này một
    // tiến trình con mang prompt "You are a ..." khởi động chậm hơn 2s, tức là có thể bị giết
    // TRƯỚC khi fixture kịp ghi bộ đếm — số lượt fixture thấy không phản ánh số lượt pipeline mở.
    const events = readTail(job, 50).map((l) => JSON.parse(l));
    assert.equal(
      events.filter((e) => e.type === 'split.attempt').length, 1,
      'hết giờ thì không được thử lại: 3 lượt là 3 × timeouts.splitter bị đốt',
    );
    assert.ok(events.some((e) => e.type === 'split.timeout'));
    assert.ok(!events.some((e) => e.type === 'split.invalid'), 'hết giờ không phải JSON hỏng');
    releaseJob(job);
  } finally {
    delete process.env.FAKE_HOLD_ON;
  }
});

test('reviewer treo quá hạn thì task timeout ngay — một lượt, không báo review_unparseable', async () => {
  chmodSync(SCRIPTED, 0o755);
  const sd = scriptDir([ONE_TASK, 'code', PASS]);
  const { cfg, dir } = cfgWith(sd, { timeouts: { splitter: 10, reviewer: 1, coder: 10 } });
  process.env.FAKE_HOLD_ON = '2'; // lượt 0 splitter, 1 coder, 2 reviewer
  try {
    const job = createJob('ke hoach', dir, ROOT);
    await runPipeline(job, cfg);
    assert.equal(job.state, 'done', 'task timeout không làm cả job hỏng');
    assert.equal(job.tasks[0].state, 'timeout');
    const events = readTail(job, 200).map((l) => JSON.parse(l));
    assert.ok(
      events.some((e) => e.type === 'task.timeout' && e.role === 'reviewer'),
      'phải gọi đúng tên là timeout của reviewer',
    );
    // Trước đây mỗi lượt treo bị coi là "JSON hỏng": ba sự kiện review.invalid (3 × hạn) rồi
    // task.review_unparseable. Không lượt nào được phép bị ghi nhận như vậy nữa.
    assert.ok(!events.some((e) => e.type === 'review.invalid'), 'hết giờ không phải JSON hỏng');
    assert.ok(!events.some((e) => e.type === 'task.review_unparseable'), 'chẩn đoán sai: reviewer treo, không phải trả rác');
    releaseJob(job);
  } finally {
    delete process.env.FAKE_HOLD_ON;
  }
});

test('guard home nằm trong gốc của job chứ không rơi vào $HOME', async () => {
  chmodSync(SCRIPTED, 0o755);
  // Gốc MỚI, chưa ai chạm: nếu runPipeline vẫn gọi ensureGuardHome() không đối số thì
  // <gốc>/codex-home không bao giờ được tạo và test này đỏ — gốc chung ROOT thì chưa chắc.
  const root = mkdtempSync(join(tmpdir(), 'mcg-pipe-fresh-'));
  const { cfg, dir } = cfgWith(scriptDir([ONE_TASK]));
  const job = createJob('ke hoach', dir, root);
  await runPipeline(job, cfg, { dryRun: true });
  assert.ok(job.dir.startsWith(root), `job.dir ${job.dir} không nằm trong ${root}`);
  assert.equal(
    readFileSync(join(root, 'codex-home', 'rules', 'guard.rules'), 'utf8'), GUARD_RULES,
    'guard home phải được dựng trong gốc của job',
  );
  releaseJob(job);
});

// --- Diff rỗng khi việc đã có sẵn: không còn vòng lặp chết ---

test('diff rỗng thì reviewer prompt dặn kiểm tra code hiện tại, và có sự kiện task.no_diff', async () => {
  // Vá hỏng đã đo thật ở ~/internship/account lẫn idp: repo có sẵn partial work chưa
  // commit thỏa mãn acceptance → coder không cần đổi gì → diff rỗng → reviewer bị bảo
  // "(no changes were made)" như thể đó là phán quyết → fail → đốt hết maxRounds →
  // needs_human. Bây giờ: (1) prompt coder dặn "đã thỏa mãn thì đừng sửa", (2) prompt
  // reviewer dặn tự mở file kiểm tra criterion trên code HIỆN TẠI, (3) có sự kiện
  // task.no_diff để log phân biệt "coder không làm gì" với "việc đã có sẵn".
  chmodSync(SCRIPTED, 0o755);
  const sd = scriptDir([ONE_TASK, 'da lam roi', PASS]);
  const { cfg, dir } = cfgWith(sd);
  const job = createJob('ke hoach', dir, ROOT);
  await runPipeline(job, cfg);

  assert.equal(job.tasks[0].state, 'passed');
  const events = readTail(job, 100).map((l) => JSON.parse(l));
  const noDiff = events.filter((e) => e.type === 'task.no_diff');
  assert.equal(noDiff.length, 1, 'diff rỗng mà chụp cây khoẻ thì phải có đúng một task.no_diff');
  assert.equal(noDiff[0].round, 1);

  // Prompt reviewer vòng đó phải dặn kiểm tra code hiện tại chứ không chỉ tin diff
  const calls = readFileSync(join(sd, 'calls.log'), 'utf8').split('===');
  const reviewerCall = calls.find((b) => b.includes('You are reviewing one task'));
  assert.ok(reviewerCall, 'phải có lượt reviewer');
  // Cụm "already exist" có thể bị xuống dòng ngay giữa chữ — khớp qua ranh giới dòng.
  assert.match(reviewerCall, /already\s+exist in the repository/, 'dặn rõ diff rỗng chưa chắc là fail');
  assert.match(reviewerCall, /CURRENT code/);

  // Prompt coder phải dặn "đã thỏa mãn thì đừng sửa chỉ để có diff"
  const coderCall = calls.find((b) => b.includes('Implement this task'));
  assert.ok(coderCall, 'phải có lượt coder');
  assert.match(coderCall, /already satisfied/i);
  assert.match(coderCall, /do NOT modify anything just to produce a diff/);

  // Đối chứng: có diff thật thì KHÔNG được có sự kiện task.no_diff
  releaseJob(job);
});

test('có diff thật thì không có sự kiện task.no_diff', async () => {
  chmodSync(SCRIPTED, 0o755);
  const sd = scriptDir([ONE_TASK, 'code', PASS]);
  const { cfg, dir } = cfgWith(sd);
  process.env.FAKE_TOUCH = join(dir, 'file-moi.ts');
  try {
    const job = createJob('ke hoach', dir, ROOT);
    await runPipeline(job, cfg);
    assert.equal(job.tasks[0].state, 'passed');
    const events = readTail(job, 100).map((l) => JSON.parse(l));
    assert.ok(!events.some((e) => e.type === 'task.no_diff'), 'có diff mà vẫn báo no_diff');
    releaseJob(job);
  } finally {
    delete process.env.FAKE_TOUCH;
  }
});

test('snapshot hỏng thì KHÔNG có sự kiện task.no_diff — đã có snapshot.failed rồi', async () => {
  // Snapshot hỏng là chuyện khác: diff rỗng lúc đó không nói được gì. task.no_diff chỉ
  // hợp lệ khi CẢ HAI lần chụp khoẻ — nếu không một cây chụp thất bại cũng sinh no_diff
  // và người đọc log bị hai sự kiện mâu thuẫn nhau.
  chmodSync(SCRIPTED, 0o755);
  const sd = scriptDir([ONE_TASK, 'code', PASS]);
  const { cfg, dir } = cfgWith(sd);
  process.env.FAKE_BREAK_GIT = join(dir, '.git');
  try {
    const job = createJob('ke hoach', dir, ROOT);
    await runPipeline(job, cfg);
    const events = readTail(job, 100).map((l) => JSON.parse(l));
    assert.ok(events.some((e) => e.type === 'snapshot.failed'));
    assert.ok(!events.some((e) => e.type === 'task.no_diff'), 'snapshot hỏng mà sinh cả no_diff');
    releaseJob(job);
  } finally {
    delete process.env.FAKE_BREAK_GIT;
  }
});
