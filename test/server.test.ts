import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

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

test('mô tả pipeline_start có nhắc điều kiện $start-task', async () => {
  const out = await rpc([INIT, INITED, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })]);
  const list = out.map((l) => JSON.parse(l)).find((m) => m.id === 2);
  const start = list.result.tools.find((t: { name: string }) => t.name === 'pipeline_start');
  assert.match(start.description, /\$start-task/);
});
