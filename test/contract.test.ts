import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContract, TaskListSchema, ReviewSchema } from '../src/contract.ts';

const ONE_TASK = {
  tasks: [{ id: '1', title: 't', detail: 'd', files: ['a.ts'], acceptance: 'ok' }],
};

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
