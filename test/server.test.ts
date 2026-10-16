import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ENTRY = resolve(import.meta.dirname, '../src/index.ts');

// `env` mặc định kế thừa môi trường của test. Các test cần config xác định thì truyền HOME tạm:
// server đọc ~/.mcp-coding-glm/config.json theo HOME, nên test không phụ thuộc vào máy người chạy
// và — nếu một lớp kiểm tra bị thủng — job sinh ra nằm trong HOME tạm chứ không phải HOME thật.
function rpc(lines: string[], env?: NodeJS.ProcessEnv): Promise<string[]> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'], env });
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

// --- Reply thất bại phải mang isError; ghi đè roles phải qua đủ các kiểm tra của loadConfig ---

const OK_CONFIG = {
  binaries: { codex: '/bin/echo' },
  providers: { gn: { baseUrl: 'https://x/v1', apiKeyEnv: 'GN_KEY' } },
  roles: {
    splitter: { runner: 'codex', provider: 'gn', model: 'm' },
    reviewer: { runner: 'codex', provider: 'gn', model: 'm' },
    coder: { runner: 'codex', provider: 'gn', model: 'm' },
  },
};

test('mọi reply thất bại đều mang isError: config hỏng và job không tồn tại', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcg-home-')); // HOME không có config nào
  const calls: Array<[string, object]> = [
    ['capabilities', {}],
    ['pipeline_start', { plan: 'p', cwd: '/tmp' }],
    ['pipeline_status', { job_id: 'khong-co' }],
    ['pipeline_result', { job_id: 'khong-co' }],
    ['pipeline_cancel', { job_id: 'khong-co' }],
  ];
  const out = await rpc([
    INIT, INITED,
    ...calls.map(([name, args], i) => JSON.stringify({
      jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: { name, arguments: args },
    })),
  ], { ...process.env, HOME: home });
  const byId = new Map(out.map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  calls.forEach(([name], i) => {
    assert.equal(byId.get(i + 2).result.isError, true, `${name} thất bại mà không mang isError`);
  });
  assert.match(byId.get(2).result.content[0].text, /Config not usable/);
  assert.match(byId.get(3).result.content[0].text, /Config not usable/);
  assert.match(byId.get(4).result.content[0].text, /No such job: khong-co/);
});

test('ghi đè roles sai bị từ chối rõ ràng, có isError, và chưa tạo job nào', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcg-home-'));
  mkdirSync(join(home, '.mcp-coding-glm'));
  writeFileSync(join(home, '.mcp-coding-glm', 'config.json'), JSON.stringify(OK_CONFIG));
  const here = mkdtempSync(join(tmpdir(), 'mcg-cwd-')); // thư mục có thật, không cần là git

  const cases: Array<[string, object, RegExp]> = [
    ['provider gõ nhầm', { roles: { coder: { provider: 'typo-provider' } } },
      /roles\.coder\.provider "typo-provider" is not declared in providers/],
    ['claude mà không có binaries.claude', { roles: { reviewer: { runner: 'claude' } } },
      /roles\.reviewer\.runner is "claude" but binaries\.claude is not configured/],
    ['coder bị đổi sang claude', { roles: { coder: { runner: 'claude' } } },
      /roles\.coder\.runner must stay "codex"/],
    ['tên vai gõ nhầm', { roles: { codr: { model: 'x' } } }, /Unrecognized key.*codr/],
    ['khoá trong vai gõ nhầm', { roles: { coder: { modle: 'x' } } }, /Unrecognized key.*modle/],
    ['model rỗng', { roles: { coder: { model: '' } } }, /roles\.coder\.model/],
    ['cwd không tồn tại', { cwd: '/khong/ton/tai' }, /cwd is not an existing directory/],
    // Đối chứng: ghi đè MỘT PHẦN hợp lệ phải qua được kiểm tra roles và dừng ở kiểm tra cwd phía
    // sau. Ca này chứng minh các kiểm tra trên không từ chối bừa — z.record(z.enum(...)) của Zod 4
    // bắt buộc đủ cả ba khoá nên sẽ từ chối luôn cả ca này.
    ['ghi đè một phần hợp lệ',
      { roles: { coder: { model: 'khac' }, reviewer: { provider: 'openai' } }, cwd: '/khong/ton/tai' },
      /cwd is not an existing directory/],
  ];
  const out = await rpc([
    INIT, INITED,
    ...cases.map(([, args], i) => JSON.stringify({
      jsonrpc: '2.0', id: i + 2, method: 'tools/call',
      params: { name: 'pipeline_start', arguments: { plan: 'p', cwd: here, ...args } },
    })),
    JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'capabilities', arguments: {} } }),
  ], { ...process.env, HOME: home, GN_KEY: 'sk-co-test' });
  const byId = new Map(out.map((l) => JSON.parse(l)).map((m) => [m.id, m]));

  cases.forEach(([label, , want], i) => {
    const res = byId.get(i + 2);
    assert.equal(res.result?.isError, true, `${label}: phải bị từ chối kèm isError`);
    assert.match(res.result.content[0].text, want, label);
  });
  assert.ok(
    !existsSync(join(home, '.mcp-coding-glm', 'jobs')),
    'bị từ chối thì không được tạo thư mục job nào — trước đây job đã sinh ra rồi mới hỏng',
  );
  // Reply thành công thì KHÔNG được mang isError.
  const caps = byId.get(99).result;
  assert.ok(!caps.isError, 'capabilities thành công mà bị đánh dấu lỗi');
  assert.match(caps.content[0].text, /splitter: runner=codex/);
  // key có mặt (qua env) thì dòng vai không được dính chữ key=MISSING
  for (const line of caps.content[0].text.split('\n')) {
    if (line.includes('provider=gn')) {
      assert.ok(!line.includes('MISSING'), `vai có key mà vẫn báo MISSING: ${line}`);
    }
  }
});

test('thiếu API key của provider thì pipeline_start từ chối ngay, không đốt vòng nào', async () => {
  // Vá hỏng đã đo thật (job e8a38182, 13/10): server không mang env key, coder chết
  // "Missing environment variable" ở MỌI vòng, cháy trọn maxRounds rồi mới needs_human.
  // Bây giờ phải bị từ chối ngay từ pipeline_start.
  const home = mkdtempSync(join(tmpdir(), 'mcg-home-'));
  mkdirSync(join(home, '.mcp-coding-glm'));
  writeFileSync(join(home, '.mcp-coding-glm', 'config.json'), JSON.stringify(OK_CONFIG));
  const here = mkdtempSync(join(tmpdir(), 'mcg-cwd-'));
  const env = { ...process.env, HOME: home };
  delete env.GN_KEY; // buộc provider "gn" không còn nguồn key nào

  const out = await rpc([
    INIT, INITED,
    JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'pipeline_start', arguments: { plan: 'p', cwd: here } },
    }),
  ], env);
  const res = out.map((l) => JSON.parse(l)).find((m) => m.id === 2);
  assert.equal(res.result?.isError, true, 'thiếu key mà vẫn start job');
  assert.match(res.result.content[0].text, /API key is missing/);
  assert.ok(
    !existsSync(join(home, '.mcp-coding-glm', 'jobs')),
    'bị từ chối vì thiếu key thì không được tạo thư mục job',
  );
});
