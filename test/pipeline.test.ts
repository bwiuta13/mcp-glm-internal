import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createJob, releaseJob, cancelJob } from '../src/jobs.ts';
import { runPipeline } from '../src/pipeline.ts';

const SCRIPTED = resolve(import.meta.dirname, 'fixtures/scripted-codex.sh');

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
  const job = createJob('ke hoach', dir);
  await runPipeline(job, cfg, { dryRun: true });
  assert.equal(job.state, 'done');
  assert.equal(job.tasks.length, 1);
  assert.equal(job.tasks[0].state, 'pending');
  releaseJob(job);
});

test('review pass ngay vòng đầu thì task passed', async () => {
  chmodSync(SCRIPTED, 0o755);
  const { cfg, dir } = cfgWith(scriptDir([ONE_TASK, 'da code xong', PASS]));
  const job = createJob('ke hoach', dir);
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

  const job = createJob('ke hoach', dir);
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
  const job = createJob('ke hoach', dir);
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
  const job = createJob('ke hoach', dir);
  const running = runPipeline(job, cfg);
  await cancelWhenCallStarts(sd, holdOn, job.id);
  await running;
  delete process.env.FAKE_HOLD_ON;
  return { job, used: Number(readFileSync(join(sd, 'counter'), 'utf8').trim()) };
}

test('huỷ lúc splitter đang chạy thì dừng hẳn', async () => {
  const { job, used } = await cancelDuringCall(0, [ONE_TASK, 'code', PASS]);
  assert.equal(job.state, 'cancelled');
  assert.equal(used, 1, `đã gọi ${used} lượt — không được gọi thêm agent nào sau khi huỷ`);
});

test('huỷ lúc coder đang chạy thì không gọi reviewer', async () => {
  const { job, used } = await cancelDuringCall(1, [ONE_TASK, 'code', PASS]);
  assert.equal(job.state, 'cancelled');
  assert.equal(used, 2, `đã gọi ${used} lượt — reviewer không được chạy`);
});

test('huỷ lúc reviewer đang chạy thì không sang vòng mới', async () => {
  const { job, used } = await cancelDuringCall(2, [ONE_TASK, 'code', FAIL, 'code', PASS]);
  assert.equal(job.state, 'cancelled');
  assert.equal(used, 3, `đã gọi ${used} lượt — không được mở vòng code mới`);
});

test('splitter hỏng thì thử đúng 3 lượt, không hơn không kém', async () => {
  chmodSync(SCRIPTED, 0o755);
  const sd = scriptDir(['rac', 'rac', 'rac', ONE_TASK]);
  const { cfg, dir } = cfgWith(sd);
  const job = createJob('ke hoach', dir);
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
  const job = createJob('ke hoach', dir);
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
  const job = createJob('ke hoach', dir);
  await runPipeline(job, cfg);
  delete process.env.FAKE_TOUCH;
  const d = readFileSync(join(job.dir, 'task-1-1', 'round-1.diff'), 'utf8');
  // `git diff` trần trả 0 byte ở đúng ca này — reviewer bị bảo "no changes were made".
  assert.match(d, /hoan-toan-moi\.ts/, 'file mới phải có trong diff');
  assert.match(d, /noi dung moi/, 'nội dung file mới phải có trong diff');
  releaseJob(job);
});

test('thư mục không phải git thì job failed ngay, không gọi agent nào', async () => {
  chmodSync(SCRIPTED, 0o755);
  const sd = scriptDir([ONE_TASK, 'code', PASS]);
  const { cfg, dir } = cfgWith(sd);
  rmSync(join(dir, '.git'), { recursive: true, force: true });
  const job = createJob('ke hoach', dir);
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
  const job = createJob('ke hoach', dir);
  await runPipeline(job, cfg);
  assert.equal(job.state, 'failed');
  assert.match(job.error ?? '', /split/i);
  releaseJob(job);
});
