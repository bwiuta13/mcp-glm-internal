import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { parseContract, TaskListSchema, ReviewSchema } from '../src/contract.ts';

const ONE_TASK = {
  tasks: [{ id: '1', title: 't', detail: 'd', files: ['a.ts'], acceptance: 'ok' }],
};
// Dựng ba dấu backtick mà không viết literal, để khối code này không tự đóng hàng rào.
const FENCE = '`'.repeat(3);

test('JSON trần thì đọc được', () => {
  const r = parseContract(JSON.stringify(ONE_TASK), TaskListSchema);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.tasks[0].id, '1');
});

test('JSON bọc trong hàng rào markdown thì vẫn đọc được', () => {
  const raw = '```json\n' + JSON.stringify(ONE_TASK) + '\n```';
  const r = parseContract(raw, TaskListSchema);
  assert.equal(r.ok, true);
});

test('có lời dẫn trước JSON thì vẫn bóc ra được', () => {
  const raw = 'Here is the plan:\n' + JSON.stringify(ONE_TASK);
  const r = parseContract(raw, TaskListSchema);
  assert.equal(r.ok, true);
});

test('id kiểu số thì ép về chuỗi, không bắt sửa', () => {
  const raw = JSON.stringify({ tasks: [{ ...ONE_TASK.tasks[0], id: 1 }] });
  const r = parseContract(raw, TaskListSchema);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.tasks[0].id, '1');
});

test('thiếu field bắt buộc thì câu sửa phải gọi tên field đó', () => {
  const raw = JSON.stringify({ tasks: [{ id: '1', title: 't', detail: 'd', acceptance: 'ok' }] });
  const r = parseContract(raw, TaskListSchema);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.repairPrompt, /tasks\.0\.files/);
});

test('không phải JSON thì câu sửa nói rõ là JSON hỏng', () => {
  const r = parseContract('xin loi toi khong biet', TaskListSchema);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.repairPrompt, /not valid JSON/);
});

test('review thiếu issues và guidance thì lấy mặc định', () => {
  const r = parseContract(JSON.stringify({ verdict: 'pass' }), ReviewSchema);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.value.issues, []);
    assert.equal(r.value.guidance, '');
  }
});

test('verdict lạ thì bị từ chối', () => {
  const r = parseContract(JSON.stringify({ verdict: 'maybe' }), ReviewSchema);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.repairPrompt, /verdict/);
});

// --- Trường hợp chính của pipeline này: model viết code VÀO TRONG chuỗi JSON ---

test('chuỗi trong JSON chứa khối code thì không bị cắt nhầm', () => {
  const withCode = {
    tasks: [{
      ...ONE_TASK.tasks[0],
      detail: `Viết hàm:\n${FENCE}ts\nexport const f = () => 1;\n${FENCE}\nrồi test nó.`,
    }],
  };
  const r = parseContract(JSON.stringify(withCode), TaskListSchema);
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.value.tasks[0].detail, /export const f/);
});

test('JSON bọc hàng rào, prose hai bên có ngoặc, vẫn bóc đúng', () => {
  const raw = `Đây là {kế hoạch} [v2]:\n${FENCE}json\n${JSON.stringify(ONE_TASK)}\n${FENCE}\nXong {ok} [1].`;
  const r = parseContract(raw, TaskListSchema);
  assert.equal(r.ok, true);
});

test('JSON đứng đầu rồi prose có ngoặc theo sau', () => {
  const r = parseContract(`${JSON.stringify(ONE_TASK)}\nXong task [1] và {2}.`, TaskListSchema);
  assert.equal(r.ok, true);
});

test('bóc được mảng ở cấp cao nhất', () => {
  const r = parseContract('Kết quả: [1,2,3]', z.array(z.number()));
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, [1, 2, 3]);
});

test('hai lỗi cùng lúc thì câu sửa liệt kê cả hai', () => {
  const raw = JSON.stringify({ tasks: [{ id: '1', title: '', detail: 'd', acceptance: 'ok' }] });
  const r = parseContract(raw, TaskListSchema);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.repairPrompt, /tasks\.0\.title/);
    assert.match(r.repairPrompt, /tasks\.0\.files/);
    assert.equal(r.repairPrompt.split('\n').filter((l) => l.startsWith('- ')).length, 2);
  }
});

test('payload sai hẳn kiểu thì câu sửa dùng (root)', () => {
  const r = parseContract('[1,2]', TaskListSchema);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.repairPrompt, /\(root\)/);
});

test('JSON cụt thì vẫn ra câu sửa của module', () => {
  const r = parseContract('{"tasks": [', TaskListSchema);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.repairPrompt, /no prose, no markdown fences/);
});

test('id null bị từ chối thay vì biến thành chuỗi "null"', () => {
  const raw = JSON.stringify({ tasks: [{ ...ONE_TASK.tasks[0], id: null }] });
  const r = parseContract(raw, TaskListSchema);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.repairPrompt, /tasks\.0\.id/);
});

test('review có file và line null thì vẫn chấp nhận', () => {
  const raw = JSON.stringify({
    verdict: 'fail',
    issues: [{ severity: 'blocker', file: null, line: null, message: 'thiếu test' }],
  });
  const r = parseContract(raw, ReviewSchema);
  assert.equal(r.ok, true);
});
