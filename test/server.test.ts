import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ENTRY = resolve(import.meta.dirname, '../src/index.ts');

function rpc(lines: string[]): Promise<string[]> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.on('close', () => done(out.split('\n').filter(Boolean)));
    for (const l of lines) child.stdin.write(l + '\n');
    child.stdin.end();
  });
}

const INIT = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
});
const INITED = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });

test('server bắt tay được và liệt kê đủ 5 tool', async () => {
  const out = await rpc([INIT, INITED, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })]);
  const list = out.map((l) => JSON.parse(l)).find((m) => m.id === 2);
  const names = list.result.tools.map((t: { name: string }) => t.name).sort();
  assert.deepEqual(names, [
    'capabilities', 'pipeline_cancel', 'pipeline_result', 'pipeline_start', 'pipeline_status',
  ]);
});

test('mô tả pipeline_start nêu RÕ điều kiện, không chỉ chứa chữ $start-task', async () => {
  const out = await rpc([INIT, INITED, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })]);
  const list = out.map((l) => JSON.parse(l)).find((m) => m.id === 2);
  const start = list.result.tools.find((t: { name: string }) => t.name === 'pipeline_start');
  // Chỉ khớp chữ "$start-task" là chưa đủ: một mô tả ĐẢO NGƯỢC luật ("đừng gọi khi có
  // $start-task, cứ gọi thoải mái lúc khác") vẫn lọt qua phép kiểm đó.
  assert.match(start.description, /ONLY call this when .*\$start-task/);
  assert.match(start.description, /Never call it on your own initiative/);
});

test('khoá lạ trong tham số bị từ chối, không bị nuốt im lặng', async () => {
  const out = await rpc([INIT, INITED, JSON.stringify({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'pipeline_start', arguments: { plan: 'p', cwd: '/tmp', dry_run: true } },
  })]);
  const res = out.map((l) => JSON.parse(l)).find((m) => m.id === 2);
  // `dry_run` gõ sai thành không có dryRun. Nuốt im lặng nghĩa là chạy THẬT và để model
  // sửa file trong một thư mục không có lưới an toàn.
  assert.ok(res.error || res.result?.isError, 'khoá lạ phải bị từ chối');
});

test('ba skill có đúng cờ chặn gọi tự phát', () => {
  const root = resolve(import.meta.dirname, '../skills');
  for (const [name, want] of [['start-task', 'false'], ['task-stop', 'false'],
                              ['task-status', 'true']] as const) {
    const yaml = readFileSync(join(root, name, 'agents', 'openai.yaml'), 'utf8');
    assert.match(yaml, new RegExp(`allow_implicit_invocation:\\s*${want}`), `skill ${name}`);
    const md = readFileSync(join(root, name, 'SKILL.md'), 'utf8');
    assert.match(md, new RegExp(`^name:\\s*${name}$`, 'm'), `frontmatter của ${name}`);
  }
});
