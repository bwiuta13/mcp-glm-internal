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
  try {
    // Chờ fixture ghi XONG pid (file có thể tồn tại mà còn rỗng). Hạn 10s chứ không
    // phải 1s: dưới tải nặng, đo được 25-64% số lần vượt quá 1 giây.
    let gcPid = 0;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (existsSync(pidFile)) {
        gcPid = Number(readFileSync(pidFile, 'utf8').trim());
        if (gcPid > 0) break;
      }
      await new Promise((res) => setTimeout(res, 20));
    }
    assert.ok(gcPid > 0, 'fixture không ghi được pid của cháu trong 10s');

    assert.equal(cancelJob(j.id), true);

    // Poll chờ ESRCH thay vì ngủ cố định: kernel dọn nhanh hay chậm tuỳ tải.
    let gone = false;
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      try {
        process.kill(gcPid, 0);
      } catch {
        gone = true;
        break;
      }
      await new Promise((res) => setTimeout(res, 20));
    }
    assert.ok(gone, `cháu pid ${gcPid} còn sống — cancelJob giết sai cách, agent thành mồ côi`);
  } finally {
    // Test đỏ cũng không được để lại `sleep 30` giữ pipe: lần chạy sau sẽ treo 40-50s.
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* đã chết */ }
  }
});

// --- Ghim những bất biến mà mutation testing cho thấy chưa ai giữ ---

test('nhả khoá muộn không được cướp khoá của job khác', () => {
  const r = root();
  const j1 = createJob('p', '/tmp/duan-f', r);
  releaseJob(j1);
  const j2 = createJob('p', '/tmp/duan-f', r);      // j2 giữ khoá
  releaseJob(j1);                                    // nhả muộn, phải là no-op
  assert.throws(() => createJob('p', '/tmp/duan-f', r), new RegExp(j2.id));
  releaseJob(j2);
});

test('huỷ xong thì mở lại được job mới trên cùng thư mục', () => {
  const r = root();
  const j1 = createJob('p', '/tmp/duan-g', r);
  assert.equal(cancelJob(j1.id), true);
  const j2 = createJob('p', '/tmp/duan-g', r);
  assert.notEqual(j2.id, j1.id);
  releaseJob(j2);
});

test('job đã kết thúc thì huỷ là no-op, không ghi đè trạng thái', () => {
  const j = createJob('p', '/tmp/duan-h', root());
  j.state = 'done';
  assert.equal(cancelJob(j.id), false, 'huỷ job đã xong phải trả false');
  assert.equal(getJob(j.id)?.state, 'done', 'trạng thái done không được thành cancelled');
  releaseJob(j);
});

test('đường dẫn viết khác nhau vẫn là cùng một khoá', () => {
  const r = root();
  const j = createJob('p', '/tmp/duan-i', r);
  for (const spelling of ['/tmp/duan-i/', '/tmp/./duan-i', '/tmp/x/../duan-i']) {
    assert.throws(
      () => createJob('p', spelling, r),
      new RegExp(j.id),
      `"${spelling}" phải đụng khoá của ${j.id}`,
    );
  }
  releaseJob(j);
});

test('sự kiện luôn có dấu thời gian kiểu số', () => {
  const j = createJob('p', '/tmp/duan-j', root());
  appendEvent(j, { type: 'thu' });
  const last = JSON.parse(readTail(j, 1)[0]);
  assert.equal(typeof last.t, 'number');
  assert.ok(last.t > 0);
  releaseJob(j);
});
