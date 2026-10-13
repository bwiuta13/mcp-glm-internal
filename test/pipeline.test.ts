import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
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
  return { cfg: loadConfig(p), dir };
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
  execFileSync('git', ['init'], { cwd: dir });
  writeFileSync(join(dir, 'chua-theo-doi.txt'), 'noi dung');

  const job = createJob('ke hoach', dir);
  await runPipeline(job, cfg);

  const taskDir = join(job.dir, 'task-1-1');
  assert.ok(existsSync(join(taskDir, 'baseline.diff')));
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

test('huỷ giữa chừng thì pipeline dừng, không spawn thêm agent nào', async () => {
  chmodSync(SCRIPTED, 0o755);
  const sd = scriptDir([ONE_TASK, 'code', PASS, 'code', PASS]);
  const { cfg, dir } = cfgWith(sd);
  const job = createJob('ke hoach', dir);
  const running = runPipeline(job, cfg);
  // Chờ splitter xong rồi mới huỷ, để chắc chắn đang ở giữa pipeline.
  for (let i = 0; i < 150 && job.tasks.length === 0; i++) {
    await new Promise((res) => setTimeout(res, 20));
  }
  cancelJob(job.id);
  await running;
  assert.equal(job.state, 'cancelled', 'không được ghi đè thành done hay failed');
  const used = Number(readFileSync(join(sd, 'counter'), 'utf8').trim());
  assert.ok(used <= 3, `đã gọi ${used} lượt agent sau khi huỷ — phải dừng hẳn`);
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
