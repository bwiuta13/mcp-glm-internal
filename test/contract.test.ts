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

// --- Ghim bộ đếm độ sâu: mọi ca dưới đây đều bọc prose để ép đi vào nhánh quét ---

test('ngoặc mở lẻ trong chuỗi không phá bộ đếm độ sâu', () => {
  const task = { ...ONE_TASK.tasks[0], detail: 'function f() { return 1;' };
  const r = parseContract('Kế hoạch:\n' + JSON.stringify({ tasks: [task] }) + '\nXong.', TaskListSchema);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.tasks[0].detail, 'function f() { return 1;');
});

test('dấu nháy escape rồi ngoặc trong chuỗi vẫn bóc đúng', () => {
  const task = { ...ONE_TASK.tasks[0], detail: 'print("{")' };
  const r = parseContract('Đây:\n' + JSON.stringify({ tasks: [task] }) + '\nHết.', TaskListSchema);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.tasks[0].detail, 'print("{")');
});

test('backslash ngay trước dấu đóng chuỗi không bị tính nhầm là escape', () => {
  const task = { ...ONE_TASK.tasks[0], detail: 'C:\\temp\\', acceptance: 'ok {' };
  const r = parseContract('Đây:\n' + JSON.stringify({ tasks: [task] }) + '\nHết.', TaskListSchema);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.tasks[0].detail, 'C:\\temp\\');
});

test('câu sửa mang theo lỗi cú pháp thật của V8', () => {
  const r = parseContract('xin loi toi khong biet', TaskListSchema);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.repairPrompt, /Unexpected token/);
});

test('JSON hỏng mà bên trong có mảnh parse được thì vẫn báo lỗi cú pháp', () => {
  // Xuống dòng THÔ trong chuỗi — lỗi hay gặp nhất khi model viết code vào JSON.
  // Không có bản vá, mảnh `["a.ts"]` sẽ thắng và câu sửa đi nói về mảng thay vì cú pháp.
  const NL = String.fromCharCode(10);
  const raw =
    '{"tasks": [{"id": "1", "title": "t", "detail": "a' + NL +
    'b", "files": ["a.ts"], "acceptance": "ok"}]}';
  const r = parseContract(raw, TaskListSchema);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.repairPrompt, /not valid JSON/);
});

test('payload cắt cụt không làm vòng quét chạy quá lâu', () => {
  const started = Date.now();
  const r = parseContract('{'.repeat(40000), TaskListSchema);
  assert.equal(r.ok, false);
  assert.ok(Date.now() - started < 1000, 'quét 40k dấu mở lẽ ra phải tuyến tính');
});

test('id rỗng, object, mảng, boolean, hay chứa đường dẫn đều bị từ chối', () => {
  for (const bad of ['', {}, [], true, '../../../x', 'a/b']) {
    const raw = JSON.stringify({ tasks: [{ ...ONE_TASK.tasks[0], id: bad }] });
    const r = parseContract(raw, TaskListSchema);
    assert.equal(r.ok, false, `id ${JSON.stringify(bad)} đáng lẽ phải bị từ chối`);
    if (!r.ok) assert.match(r.repairPrompt, /tasks\.0\.id/);
  }
});

test('issue thiếu hẳn file và line thì vẫn chấp nhận', () => {
  const raw = JSON.stringify({ verdict: 'fail', issues: [{ severity: 'minor', message: 'x' }] });
  const r = parseContract(raw, ReviewSchema);
  assert.equal(r.ok, true);
});

// --- Mỗi lượt chạy là một `codex exec` mới, không có lịch sử: câu sửa phải tự mang nội dung cần sửa ---

test('câu sửa mang theo chính câu trả lời bị từ chối, cho cả hai loại lỗi', () => {
  const notJson = parseContract('MARKER-A xin loi toi khong biet', TaskListSchema);
  assert.equal(notJson.ok, false);
  if (!notJson.ok) assert.match(notJson.repairPrompt, /<rejected_reply>\nMARKER-A xin loi toi khong biet\n<\/rejected_reply>/);

  const wrongShape = parseContract(
    JSON.stringify({ tasks: [{ id: '1', title: 'MARKER-B', detail: 'd', acceptance: 'ok' }] }),
    TaskListSchema,
  );
  assert.equal(wrongShape.ok, false);
  if (!wrongShape.ok) {
    assert.match(wrongShape.repairPrompt, /tasks\.0\.files/, 'vẫn phải gọi tên vấn đề');
    assert.match(wrongShape.repairPrompt, /<rejected_reply>\n.*MARKER-B.*\n<\/rejected_reply>/, 'và kèm câu bị từ chối');
  }
});

test('câu trả lời bị từ chối được cắt ở 4000 ký tự và có ghi chú cắt bớt', () => {
  const r = parseContract('x'.repeat(10_000) + 'TAIL-MARKER', TaskListSchema);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.repairPrompt.length < 5_000, `câu sửa dài ${r.repairPrompt.length} — chưa cắt`);
    assert.ok(!r.repairPrompt.includes('TAIL-MARKER'), 'đuôi của câu trả lời phải bị cắt');
    assert.match(r.repairPrompt, /\[\.\.\. truncated 6011 more characters\]/);
  }
});

test('câu trả lời rỗng được ghi rõ là rỗng thay vì để một khối trống', () => {
  const r = parseContract('', TaskListSchema);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.repairPrompt, /<rejected_reply>\n\(empty\)\n<\/rejected_reply>/);
});

test('line dạng chuỗi số được ép về số, null vẫn là null chứ không thành 0', () => {
  const raw = JSON.stringify({
    verdict: 'fail',
    issues: [
      { severity: 'minor', file: 'a.ts', line: '3', message: 'x' },
      { severity: 'minor', file: null, line: null, message: 'y' },
    ],
  });
  const r = parseContract(raw, ReviewSchema);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.strictEqual(r.value.issues[0].line, 3);
    assert.strictEqual(r.value.issues[1].line, null);
  }
});
