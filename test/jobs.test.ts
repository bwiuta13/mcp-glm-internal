import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJob, getJob, appendEvent, readTail, releaseJob, cancelJob } from '../src/jobs.ts';

const root = () => mkdtempSync(join(tmpdir(), 'mcg-jobs-'));

test('tạo job thì có thư mục log và trạng thái khởi đầu', () => {
  const j = createJob('ke hoach', '/tmp/duan-a', root());
  assert.equal(j.state, 'queued');
  assert.equal(j.cwd, '/tmp/duan-a');
  assert.ok(existsSync(j.dir));
  assert.equal(getJob(j.id)?.id, j.id);
});

test('cùng một cwd không mở được job thứ hai', () => {
  const r = root();
  const j = createJob('p', '/tmp/duan-b', r);
  assert.throws(() => createJob('p2', '/tmp/duan-b', r), new RegExp(j.id));
  releaseJob(j);
  const j2 = createJob('p3', '/tmp/duan-b', r); // sau khi gỡ khoá thì mở được
  assert.notEqual(j2.id, j.id);
});

test('sự kiện ghi thêm và đọc được đuôi', () => {
  const j = createJob('p', '/tmp/duan-c', root());
  for (let i = 0; i < 5; i++) appendEvent(j, { n: i });
  const tail = readTail(j, 2);
  assert.equal(tail.length, 2);
  assert.match(tail[1], /"n":4/);
});

test('huỷ job chuyển trạng thái sang cancelled', () => {
  const j = createJob('p', '/tmp/duan-d', root());
  assert.equal(cancelJob(j.id), true);
  assert.equal(getJob(j.id)?.state, 'cancelled');
  assert.equal(cancelJob('khong-co'), false);
});

test('huỷ job giết cả CHÁU, không chỉ con trực tiếp', async () => {
  const dir = root();
  const j = createJob('p', '/tmp/duan-e', dir);
  const pidFile = join(dir, 'gc.pid');

  // Spawn thẳng ở đây, không qua runner: test này chỉ nói về cancelJob.
  const child = spawn('sh', ['-c', `sleep 30 & echo $! > "${pidFile}"; wait`], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  j.children.add(child);
  // Chờ fixture ghi xong pid của cháu.
  for (let i = 0; i < 50 && !existsSync(pidFile); i++) {
    await new Promise((res) => setTimeout(res, 20));
  }
  const gcPid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(gcPid > 0, 'chưa đọc được pid của cháu');

  assert.equal(cancelJob(j.id), true);
  await new Promise((res) => setTimeout(res, 300)); // nhường nhịp cho kernel dọn
  assert.throws(
    () => process.kill(gcPid, 0),
    /ESRCH/,
    `cháu pid ${gcPid} còn sống — cancelJob giết sai cách, agent thành mồ côi`,
  );
});
