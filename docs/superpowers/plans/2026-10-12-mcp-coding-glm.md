# mcp-coding-glm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Một MCP server stdio chạy local, để Codex (host) điều phối pipeline coding nhiều model: chia plan thành task, giao GLM viết code, cho một model khác review, lặp đến khi đạt.

**Architecture:** MCP server là máy trạng thái + trình quản lý tiến trình con; nó không tự suy luận và không tự sửa file. Mỗi vai trò (splitter / reviewer / coder) được thực thi bằng cách spawn một CLI đã đăng nhập sẵn (`codex` hoặc `claude`) với provider/model lấy từ config. Job chạy bất đồng bộ, host poll trạng thái.

**Tech Stack:** Node 22.23.2 (type-stripping gốc, **không có bước build**), TypeScript, `@modelcontextprotocol/server@^2.3.1`, `zod@^4`, test bằng `node --test` dựng sẵn.

**Spec:** `docs/superpowers/specs/2026-10-12-mcp-coding-glm-design.md`

## Global Constraints

Mọi task đều ngầm bao gồm mục này.

- **Node >= 22.18**; đã xác minh trên 22.23.2. Chạy `.ts` trực tiếp bằng `node src/index.ts`, **không `tsc`, không `tsx`, không thư mục build**.
- Package MCP là **`@modelcontextprotocol/server`** (v2.3.1), **không phải** `@modelcontextprotocol/sdk`. Import: `{ McpServer }` từ `@modelcontextprotocol/server`, `{ StdioServerTransport }` từ `@modelcontextprotocol/server/stdio`.
- `registerTool(name, { description, inputSchema }, handler)` — `inputSchema` nhận **raw shape** `{ x: z.string() }`, **không phải** `z.object({...})`. Handler trả `{ content: [{ type: 'text', text }] }`.
- `node --test` **không nhận đối số là thư mục**; phải dùng glob: `node --test "test/**/*.test.ts"`.
- Vai CODER khoá cứng `-s workspace-write`. **Cấm** `danger-full-access` — nó vô hiệu hoá execpolicy (openai/codex#25312).
- Vai SPLITTER và REVIEWER khoá cứng `-s read-only`.
- Vai CODER **bắt buộc** `runner: "codex"`. Lá chắn git chỉ tồn tại cho runner codex.
- Agent **không bao giờ** được `git commit` / `git push`. Chặn bằng execpolicy `decision="forbidden"` trong `CODEX_HOME` riêng.
- **Không dùng structured output phía provider.** Gateway GreenNode nhận `json_schema` nhưng không tuân thủ. Dùng prompt + tự validate + vòng sửa kèm lỗi cụ thể.
- Mọi đường dẫn binary phải **tuyệt đối**; app GUI không kế thừa PATH của shell.
- Config file là **nguồn chân lý duy nhất**. Không tự dò runner, không tự đổi model.
- Task chạy **tuần tự**. Một job tại một thời điểm cho mỗi `cwd`.
- Mặc định: `maxRounds = 3`, `snapshotUntracked = false`.
- **Quy tắc người dùng (ưu tiên cao nhất):** không tách hàm chỉ để phục vụ file test; không tách hàm chỉ dùng một lần cho một việc đặc thù. Test đi qua entry point sẵn có. Khe test duy nhất được phép dùng là trường `binaries` trong config — nó tồn tại cho production, test chỉ mượn lại.

---

## File Structure

```
mcp-coding-glm/
├── package.json
├── .gitignore
├── src/
│   ├── index.ts      # Wiring 5 MCP tool + nối stdio. Không chứa logic nghiệp vụ.
│   ├── config.ts     # Nạp + validate config, kiểm binary tuyệt đối, hằng ROLE_SANDBOX.
│   ├── contract.ts   # Bóc JSON khỏi markdown, validate, sinh câu lệnh sửa cụ thể.
│   ├── runner.ts     # Dựng CODEX_HOME có rules; spawn codex/claude; timeout; thu kết quả.
│   ├── pipeline.ts   # Máy trạng thái SPLIT→CODE→REVIEW→FIX. Chứa luôn prompt template.
│   └── jobs.ts       # Kho job: tạo, khoá theo cwd, thư mục log, status/result/cancel.
├── skills/
│   ├── start-task/{SKILL.md, agents/openai.yaml}
│   ├── task-status/{SKILL.md, agents/openai.yaml}
│   └── task-stop/{SKILL.md, agents/openai.yaml}
├── scripts/install.sh
└── test/
    ├── fixtures/fake-codex.sh
    ├── config.test.ts
    ├── contract.test.ts
    ├── guard.test.ts
    ├── runner.test.ts
    ├── pipeline.test.ts
    └── server.test.ts
```

Prompt template nằm trong `pipeline.ts` chứ không tách file riêng: mỗi prompt chỉ phục vụ đúng một bước của máy trạng thái, tách ra là vi phạm quy tắc "dùng một lần thì không tách".

---

### Task 1: Scaffold + config loader

**Files:**
- Create: `package.json`, `.gitignore`, `src/config.ts`, `test/config.test.ts`

**Interfaces:**
- Consumes: (không có — task đầu tiên)
- Produces:
  - `ROLE_SANDBOX: { splitter: 'read-only', reviewer: 'read-only', coder: 'workspace-write' }`
  - `type Role = 'splitter' | 'reviewer' | 'coder'`
  - `type Config` (xem schema trong Step 3)
  - `loadConfig(path?: string): Config` — ném `Error` với thông điệp đọc được khi hỏng

- [ ] **Step 1: Tạo package.json và .gitignore**

`package.json`:

```json
{
  "name": "mcp-coding-glm",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.18" },
  "scripts": {
    "start": "node src/index.ts",
    "test": "node --test \"test/**/*.test.ts\""
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^2.3.1",
    "zod": "^4.6.6"
  }
}
```

`.gitignore`:

```
node_modules/
*.log
```

Chạy: `npm install`

- [ ] **Step 2: Viết test thất bại cho config loader**

`test/config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ROLE_SANDBOX } from '../src/config.ts';

function writeCfg(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcg-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

const GOOD = {
  binaries: { codex: '/bin/echo' },
  providers: { greennode: { baseUrl: 'https://x/v1', apiKeyEnv: 'GN_KEY' } },
  roles: {
    splitter: { runner: 'codex', provider: 'greennode', model: 'z-ai/glm-5.3' },
    reviewer: { runner: 'codex', provider: 'greennode', model: 'z-ai/glm-5.3' },
    coder: { runner: 'codex', provider: 'greennode', model: 'z-ai/glm-5.3' },
  },
};

test('sandbox của mỗi vai là cố định', () => {
  assert.equal(ROLE_SANDBOX.coder, 'workspace-write');
  assert.equal(ROLE_SANDBOX.splitter, 'read-only');
  assert.equal(ROLE_SANDBOX.reviewer, 'read-only');
});

test('config hợp lệ thì áp mặc định', () => {
  const cfg = loadConfig(writeCfg(GOOD));
  assert.equal(cfg.maxRounds, 3);
  assert.equal(cfg.snapshotUntracked, false);
  assert.equal(cfg.timeouts.coder, 900);
  assert.equal(cfg.providers.greennode.wireApi, 'responses');
});

test('thiếu file thì báo đường dẫn', () => {
  assert.throws(() => loadConfig('/khong/ton/tai.json'), /Config not found/);
});

test('JSON hỏng thì nói rõ là JSON hỏng', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcg-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, '{ hỏng');
  assert.throws(() => loadConfig(p), /not valid JSON/);
});

test('đường dẫn binary tương đối bị từ chối', () => {
  const bad = { ...GOOD, binaries: { codex: 'codex' } };
  assert.throws(() => loadConfig(writeCfg(bad)), /must be an absolute path/);
});

test('binary không tồn tại trên đĩa thì từ chối', () => {
  const bad = { ...GOOD, binaries: { codex: '/khong/co/codex' } };
  assert.throws(() => loadConfig(writeCfg(bad)), /not found on disk/);
});

test('khai runner claude mà không khai binaries.claude thì từ chối', () => {
  const bad = { ...GOOD, roles: { ...GOOD.roles, reviewer: { runner: 'claude', model: 'sonnet' } } };
  assert.throws(() => loadConfig(writeCfg(bad)), /binaries\.claude is not configured/);
});

test('provider lạ thì từ chối', () => {
  const bad = { ...GOOD, roles: { ...GOOD.roles, coder: { runner: 'codex', provider: 'khongco', model: 'm' } } };
  assert.throws(() => loadConfig(writeCfg(bad)), /is not declared in providers/);
});

test('coder không phải runner codex thì từ chối', () => {
  const bad = {
    ...GOOD,
    binaries: { codex: '/bin/echo', claude: '/bin/echo' },
    roles: { ...GOOD.roles, coder: { runner: 'claude', model: 'sonnet' } },
  };
  assert.throws(() => loadConfig(writeCfg(bad)), /roles\.coder\.runner must be "codex"/);
});
```

- [ ] **Step 3: Chạy test để xác nhận nó hỏng**

Chạy: `npm test`
Kỳ vọng: FAIL với `Cannot find module '../src/config.ts'`

- [ ] **Step 4: Viết src/config.ts**

```ts
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';

export type Role = 'splitter' | 'reviewer' | 'coder';

/** Sandbox do vai trò quyết định, không do config — xem Global Constraints. */
export const ROLE_SANDBOX = {
  splitter: 'read-only',
  reviewer: 'read-only',
  coder: 'workspace-write',
} as const satisfies Record<Role, string>;

const RoleCfg = z.object({
  runner: z.enum(['codex', 'claude']),
  provider: z.string().optional(),
  model: z.string().min(1),
  effort: z.string().optional(),
});

const ConfigSchema = z.object({
  binaries: z.object({ codex: z.string(), claude: z.string().optional() }),
  providers: z
    .record(
      z.string(),
      z.object({
        baseUrl: z.string().min(1),
        apiKeyEnv: z.string().min(1),
        wireApi: z.literal('responses').default('responses'),
      }),
    )
    .default({}),
  roles: z.object({ splitter: RoleCfg, reviewer: RoleCfg, coder: RoleCfg }),
  maxRounds: z.number().int().positive().default(3),
  timeouts: z
    .object({
      splitter: z.number().int().positive().default(300),
      reviewer: z.number().int().positive().default(300),
      coder: z.number().int().positive().default(900),
    })
    .default({ splitter: 300, reviewer: 300, coder: 900 }),
  snapshotUntracked: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG_PATH = join(homedir(), '.mcp-coding-glm', 'config.json');

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): Config {
  if (!existsSync(path)) throw new Error(`Config not found: ${path}`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Config is not valid JSON: ${path} — ${(e as Error).message}`);
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Config invalid: ${path}\n${detail}`);
  }
  const cfg = parsed.data;

  // App GUI không kế thừa PATH của shell, nên binary phải tuyệt đối và có thật.
  for (const [name, p] of Object.entries(cfg.binaries)) {
    if (!p) continue;
    if (!p.startsWith('/')) throw new Error(`binaries.${name} must be an absolute path, got: ${p}`);
    if (!existsSync(p)) throw new Error(`binaries.${name} not found on disk: ${p}`);
  }

  // Lá chắn git (execpolicy) chỉ áp được cho runner codex.
  if (cfg.roles.coder.runner !== 'codex') {
    throw new Error('roles.coder.runner must be "codex" — the git guard only applies to the codex runner');
  }

  for (const [role, rc] of Object.entries(cfg.roles)) {
    if (rc.runner === 'claude' && !cfg.binaries.claude) {
      throw new Error(`roles.${role}.runner is "claude" but binaries.claude is not configured`);
    }
    if (rc.runner === 'codex' && rc.provider && rc.provider !== 'openai' && !cfg.providers[rc.provider]) {
      throw new Error(`roles.${role}.provider "${rc.provider}" is not declared in providers`);
    }
  }

  return cfg;
}
```

- [ ] **Step 5: Chạy test để xác nhận đã xanh**

Chạy: `npm test`
Kỳ vọng: PASS, 9 test

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore src/config.ts test/config.test.ts
git commit -m "feat: config loader with absolute-binary and role validation"
```

---

### Task 2: Hợp đồng JSON — bóc, validate, sinh câu sửa

**Files:**
- Create: `src/contract.ts`, `test/contract.test.ts`

**Interfaces:**
- Consumes: (không phụ thuộc task trước)
- Produces:
  - `TaskListSchema`, `ReviewSchema` (zod)
  - `type TaskItem = { id: string; title: string; detail: string; files: string[]; acceptance: string }`
  - `type Review = { verdict: 'pass' | 'fail'; issues: {severity,file?,line?,message}[]; guidance: string }`
  - `parseContract<T>(raw: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; repairPrompt: string }`

Lý do tồn tại của module này đã được quan sát thực tế: gateway GreenNode **nhận** `json_schema` nhưng **không tuân thủ** — `glm-5.2` trả JSON bọc trong ```` ``` ````, thiếu field bắt buộc, và trả `id` kiểu số thay vì chuỗi.

- [ ] **Step 1: Viết test thất bại**

`test/contract.test.ts`:

```ts
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
```

- [ ] **Step 2: Chạy test để xác nhận nó hỏng**

Chạy: `npm test`
Kỳ vọng: FAIL với `Cannot find module '../src/contract.ts'`

- [ ] **Step 3: Viết src/contract.ts**

```ts
import * as z from 'zod';

export const TaskListSchema = z.object({
  tasks: z
    .array(
      z.object({
        // Chỉ ép SỐ về chuỗi (đã quan sát glm-5.2 trả id kiểu số). Ép mọi thứ sẽ
        // biến null thành "null" và object thành "[object Object]" — mà id này đi
        // thẳng vào tên thư mục log `task-<id>` và bộ lọc `only` của Task 5.
        // Ràng buộc bộ ký tự, không chỉ "chuỗi không rỗng": Task 5 dựng tên thư mục
        // log `task-<id>`, nên "../../../x" hay "a/b" sẽ thoát ra ngoài thư mục job.
        id: z.preprocess(
          (v) => (typeof v === 'number' ? String(v) : v),
          z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        ),
        title: z.string().min(1),
        detail: z.string().min(1),
        files: z.array(z.string()),
        acceptance: z.string().min(1),
      }),
    )
    .min(1),
});

export const ReviewSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  issues: z
    .array(
      z.object({
        severity: z.enum(['blocker', 'major', 'minor']),
        // LLM thường trả null cho field vắng mặt. Từ chối null ở đây tốn nguyên
        // một lượt reviewer chạy lại, nên nhận cả null lẫn undefined.
        file: z.string().nullish(),
        line: z.number().int().nullish(),
        message: z.string(),
      }),
    )
    .default([]),
  guidance: z.string().default(''),
});

export type TaskItem = z.infer<typeof TaskListSchema>['tasks'][number];
export type Review = z.infer<typeof ReviewSchema>;

export type ContractResult<T> = { ok: true; value: T } | { ok: false; repairPrompt: string };

export function parseContract<T>(raw: string, schema: z.ZodType<T>): ContractResult<T> {
  const text = raw.trim();

  // Output của model là prose, hàng rào ``` và JSON trộn theo thứ tự bất kỳ — và một
  // giá trị chuỗi TRONG JSON hoàn toàn có thể chứa khối ``` của chính nó, vì ta bảo
  // splitter viết `detail` đủ chi tiết và bảo reviewer viết `guidance`. Nên khớp hàng
  // rào bằng regex, hay cắt từ dấu mở đầu tới dấu đóng cuối, đều phá hỏng payload hợp lệ.
  // Thay vào đó: thử cả chuỗi trước, rồi quét tìm span {...} hoặc [...] cân bằng đầu tiên
  // parse được, với bộ đếm độ sâu biết bỏ qua dấu nằm trong chuỗi.
  let data: unknown;
  let found = false;
  let firstError = '';

  try {
    data = JSON.parse(text);
    found = true;
  } catch (e) {
    firstError = (e as Error).message;
  }

  for (let i = 0; i < text.length && !found; i++) {
    const open = text[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closed = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        inString = true;
      } else if (c === open) {
        depth++;
      } else if (c === close) {
        depth--;
        if (depth === 0) {
          closed = true;
          try {
            data = JSON.parse(text.slice(i, j + 1));
            found = true;
          } catch {
            // Span cân bằng nhưng không phải JSON: bỏ qua CẢ span. Thử lại từng dấu mở
            // bên trong nó vừa cho chẩn đoán sai — một mảnh con parse được sẽ thắng, và
            // câu sửa đi nói về mảnh con thay vì nói về lỗi cú pháp thật — vừa làm vòng
            // quét thành O(n^2).
            i = j;
          }
          break;
        }
      }
    }
    // Dấu mở không bao giờ đóng (payload bị cắt cụt): mọi dấu mở phía sau đều nằm bên
    // trong nó, quét tiếp chỉ tốn thời gian mà không đổi kết quả.
    if (!closed) break;
  }

  if (!found) {
    return {
      ok: false,
      repairPrompt:
        `Your previous reply was not valid JSON (${firstError}). ` +
        `Reply with JSON only — no prose, no markdown fences.`,
    };
  }

  const parsed = schema.safeParse(data);
  if (parsed.success) return { ok: true, value: parsed.data };

  // Câu sửa phải gọi đích danh từng vấn đề; "sai rồi, làm lại" không đủ để model sửa đúng.
  const detail = parsed.error.issues
    .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  return {
    ok: false,
    repairPrompt:
      `Your previous JSON did not match the required shape. ` +
      `Fix exactly these problems and reply with JSON only:\n${detail}`,
  };
}
```

- [ ] **Step 4: Chạy test để xác nhận đã xanh**

Chạy: `npm test`
Kỳ vọng: PASS, 37 test (12 từ Task 1 + 25 mới)

- [ ] **Step 5: Commit**

```bash
git add src/contract.ts test/contract.test.ts
git commit -m "feat: JSON contract with fence stripping and targeted repair prompts"
```

---

### Task 3: Runner + lá chắn git

**Files:**
- Create: `src/runner.ts`, `test/guard.test.ts`, `test/runner.test.ts`, `test/fixtures/fake-codex.sh`

**Interfaces:**
- Consumes: `ROLE_SANDBOX`, `type Config`, `type Role` từ `src/config.ts`
- Produces:
  - `GUARD_RULES: string`
  - `ensureGuardHome(root?: string): string` — trả đường dẫn CODEX_HOME đã có `rules/guard.rules`
  - `type RunResult = { exitCode: number; stdout: string; stderr: string; lastMessage: string; timedOut: boolean }`
  - `runRole(role: Role, cfg: Config, opts: { prompt, cwd, guardHome, outFile, onSpawn? }): Promise<RunResult>`

- [ ] **Step 1: Viết test lá chắn git (tầng 2 của chiến lược test)**

`test/guard.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ensureGuardHome, GUARD_RULES } from '../src/runner.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('rules chặn git commit và git push, cho qua lệnh vô hại', (t) => {
  // Giải binary NGAY TẠI ĐÂY, không đi qua config của người dùng. Test này là chuông báo
  // khi Codex nâng cấp đổi cú pháp rules, nên nó phải chạy được trên một clone sạch —
  // phụ thuộc vào ~/.mcp-coding-glm/config.json là tự tắt chuông vĩnh viễn.
  let bin = process.env.CODEX_BIN ?? '';
  if (!bin) {
    try {
      bin = execFileSync('sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).trim();
    } catch {
      bin = '';
    }
  }
  if (!bin) {
    // Trên CI thì thiếu codex là lỗi, không phải lý do bỏ qua.
    assert.ok(!process.env.CI && !process.env.REQUIRE_CODEX, 'không tìm thấy binary codex');
    return t.skip('máy này không có codex');
  }

  // Neo theo dòng: thiếu /m thì một `.*` có thể vắt qua xuống dòng và khớp nhầm chữ
  // "forbidden" của rule bên cạnh, khiến rule bị hạ xuống "allow" mà test vẫn xanh.
  assert.match(GUARD_RULES, /^prefix_rule\(pattern=\["git","commit"\], decision="forbidden"/m);
  assert.match(GUARD_RULES, /^prefix_rule\(pattern=\["git","push"\], decision="forbidden"/m);

  const home = ensureGuardHome(mkdtempSync(join(tmpdir(), 'mcg-guard-')));
  const rules = join(home, 'rules', 'guard.rules');

  const decide = (cmd: string[]): string => {
    const out = execFileSync(bin, ['execpolicy', 'check', '--rules', rules, '--', ...cmd], {
      encoding: 'utf8',
    });
    return JSON.parse(out).decision ?? 'none';
  };

  assert.equal(decide(['git', 'commit', '-m', 'x']), 'forbidden');
  assert.equal(decide(['git', 'push', 'origin', 'main']), 'forbidden');
  assert.notEqual(decide(['git', 'status']), 'forbidden');
  assert.notEqual(decide(['npm', 'test']), 'forbidden');
});
```

- [ ] **Step 2: Tạo binary giả để test runner**

`test/fixtures/fake-codex.sh` (nhớ `chmod +x`):

```bash
#!/bin/sh
# Giả lập `codex exec`. Cờ điều khiển, đặt qua env:
#   FAKE_LAST_MESSAGE        nội dung ghi vào file sau -o
#   FAKE_NO_WRITE            cố tình KHÔNG ghi file -o (ghim rmSync)
#   FAKE_EXIT                mã thoát
#   FAKE_SLEEP               ngủ rồi mới thoát — dùng `exec`, xem ghi chú ở cuối file
#   FAKE_BIG_UTF8            số lần lặp chuỗi tiếng Việt ra stdout+stderr (ghim setEncoding)
#   FAKE_GRANDCHILD_PIDFILE  đẻ cháu TRONG nhóm, ghi pid ra file rồi wait (ghim group kill)
#   FAKE_ESCAPED_NODE        đường dẫn node để đẻ cháu THOÁT nhóm (ghim stream destroy)
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
echo '{"type":"item.completed","item":{"type":"agent_message"}}'
# KHÔNG dùng "${FAKE_LAST_MESSAGE:-{...}}": trong POSIX sh dấu } đầu tiên đóng ${...},
# dấu } thứ hai thành ký tự thường, nên khi biến có giá trị sẽ in thừa một }.
if [ -n "$FAKE_NO_WRITE" ]; then
  :   # cố tình không ghi -o, để test ghim được rmSync
elif [ -n "$out" ]; then
  if [ -n "$FAKE_LAST_MESSAGE" ]; then
    printf '%s' "$FAKE_LAST_MESSAGE"
  else
    printf '%s' '{"tasks":[]}'
  fi > "$out"
fi
# Đổ nhiều văn bản tiếng Việt ra stdout để ghim setEncoding: ký tự nhiều byte bị cắt
# ngang ranh giới chunk sẽ thành U+FFFD nếu decode từng chunk rời.
if [ -n "$FAKE_BIG_UTF8" ]; then
  awk -v n="$FAKE_BIG_UTF8" 'BEGIN{s="nhiều ký tự tiếng Việt: ăâêôơưđ ÀÁẠẢÃ ";for(i=0;i<n;i++)printf "%s",s}'
  awk -v n="$FAKE_BIG_UTF8" 'BEGIN{s="lỗi tiếng Việt: ăâêôơưđ ÀÁẠẢÃ ";for(i=0;i<n;i++)printf "%s",s}' >&2
fi
# Cháu NẰM TRONG nhóm tiến trình: chỉ chết nếu runRole giết theo nhóm.
if [ -n "$FAKE_GRANDCHILD_PIDFILE" ]; then
  sleep 30 &
  echo $! > "$FAKE_GRANDCHILD_PIDFILE"
  wait
fi
# Cháu THOÁT khỏi nhóm nhưng vẫn giữ pipe: chỉ thoát được nhờ destroy phía ta.
# Dùng node thay perl/setsid vì macOS không có setsid(1).
if [ -n "$FAKE_ESCAPED_NODE" ]; then
  "$FAKE_ESCAPED_NODE" -e 'require("child_process").spawn("sleep",["8"],{detached:true,stdio:["ignore","inherit","inherit"]}).unref()'
  sleep 5
fi
# `exec` CỐ Ý: thay hẳn shell bằng sleep để leader không sống sót sau khi con chết.
# Đổi về `sleep` thường sẽ làm test timeout đua và đỏ ngẫu nhiên.
if [ -n "$FAKE_SLEEP" ]; then exec sleep "$FAKE_SLEEP"; fi
exit "${FAKE_EXIT:-0}"
```

`test/fixtures/record-exec.sh` — ghi lại argv và env để test khẳng định các cờ an toàn
(nhớ `chmod +x`):

```bash
#!/bin/sh
# Ghi argv và vài biến env ra $RECORD_TO để test kiểm chứng cờ an toàn của runRole.
out="$RECORD_TO"
{
  echo "ARGV_BEGIN"
  for a in "$@"; do printf '%s\n' "$a"; done
  echo "ARGV_END"
  echo "CODEX_HOME=$CODEX_HOME"
  echo "PATH=$PATH"
} > "$out"
exit 0
```

- [ ] **Step 3: Viết test thất bại cho runner**

`test/runner.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { runRole, ensureGuardHome, GUARD_RULES } from '../src/runner.ts';

const FAKE = resolve(import.meta.dirname, 'fixtures/fake-codex.sh');

function cfgWith(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcg-run-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify({
    binaries: { codex: FAKE },
    providers: { greennode: { baseUrl: 'https://x/v1', apiKeyEnv: 'GN_KEY' } },
    roles: {
      splitter: { runner: 'codex', provider: 'greennode', model: 'm1' },
      reviewer: { runner: 'codex', provider: 'greennode', model: 'm1' },
      coder: { runner: 'codex', provider: 'greennode', model: 'm2' },
    },
    ...extra,
  }));
  return { cfg: loadConfig(p), dir };
}

test('ensureGuardHome ghi đúng nội dung rules', () => {
  const home = ensureGuardHome(mkdtempSync(join(tmpdir(), 'mcg-g-')));
  const body = readFileSync(join(home, 'rules', 'guard.rules'), 'utf8');
  assert.equal(body, GUARD_RULES);
  // Neo theo dòng, không dùng cờ /s: `.*` vắt qua xuống dòng sẽ khớp chữ "forbidden"
  // của rule kế bên, nên hạ rule commit xuống "allow" mà test vẫn xanh.
  assert.match(body, /^prefix_rule\(pattern=\["git","commit"\], decision="forbidden"/m);
  assert.match(body, /^prefix_rule\(pattern=\["git","push"\], decision="forbidden"/m);
});

test('runRole đọc được lastMessage từ file -o', async () => {
  chmodSync(FAKE, 0o755);
  const { cfg, dir } = cfgWith();
  const out = join(dir, 'last.txt');
  process.env.FAKE_LAST_MESSAGE = '{"tasks":[]}';
  const r = await runRole('splitter', cfg, {
    prompt: 'xin chao', cwd: dir, guardHome: ensureGuardHome(dir), outFile: out,
  });
  delete process.env.FAKE_LAST_MESSAGE;
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.lastMessage, '{"tasks":[]}');
});

test('exit khác 0 được báo lại trung thực', async () => {
  chmodSync(FAKE, 0o755);
  const { cfg, dir } = cfgWith();
  process.env.FAKE_EXIT = '3';
  const r = await runRole('coder', cfg, {
    prompt: 'x', cwd: dir, guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
  });
  delete process.env.FAKE_EXIT;
  assert.equal(r.exitCode, 3);
});

test('quá giờ thì bị giết và đánh dấu timedOut', async () => {
  chmodSync(FAKE, 0o755);
  const { cfg, dir } = cfgWith({ timeouts: { splitter: 1, reviewer: 1, coder: 1 } });
  process.env.FAKE_SLEEP = '5';
  const started = Date.now();
  const r = await runRole('coder', cfg, {
    prompt: 'x', cwd: dir, guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
  });
  const elapsed = Date.now() - started;
  delete process.env.FAKE_SLEEP;
  assert.equal(r.timedOut, true);
  // Cuộc đua cũ (SIGKILL hạ `sleep` trước, `sh` kịp chạy `exit 0`) đã biến mất nhờ
  // `exec sleep` trong fixture: giờ con trực tiếp CHÍNH LÀ sleep, không còn shell để
  // thức dậy. Đo lại: 0/100 lần đỏ. Giữ assertion này vì nó ghim họ mutant `code ?? 0`.
  assert.equal(r.exitCode, -1, 'phải bị giết, không được tự thoát 0');
  assert.ok(elapsed < 3000, `hạn 1s mà settle mất ${elapsed}ms`);
});

// --- Ghim argv và env an toàn: đây là chỗ mutation testing cho thấy hổng nhất ---

const RECORD = resolve(import.meta.dirname, 'fixtures/record-exec.sh');

async function argvOf(role: 'splitter' | 'reviewer' | 'coder', provider: string | null) {
  chmodSync(RECORD, 0o755);
  const dir = mkdtempSync(join(tmpdir(), 'mcg-rec-'));
  const p = join(dir, 'config.json');
  const roleCfg = (m: string) =>
    provider ? { runner: 'codex', provider, model: m } : { runner: 'codex', model: m };
  writeFileSync(p, JSON.stringify({
    binaries: { codex: RECORD },
    providers: { gn: { baseUrl: 'https://x/v1', apiKeyEnv: 'GN_KEY' } },
    roles: { splitter: roleCfg('m1'), reviewer: roleCfg('m1'), coder: roleCfg('m2') },
  }));
  const rec = join(dir, 'rec.txt');
  process.env.RECORD_TO = rec;
  await runRole(role, loadConfig(p), {
    prompt: 'xin chao', cwd: dir, guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
  });
  delete process.env.RECORD_TO;
  const body = readFileSync(rec, 'utf8');
  const argv = body.split('ARGV_BEGIN\n')[1].split('\nARGV_END')[0].split('\n');
  return { argv, body };
}

test('coder chạy workspace-write, splitter và reviewer chạy read-only', async () => {
  for (const [role, want] of [['coder', 'workspace-write'], ['splitter', 'read-only'],
                              ['reviewer', 'read-only']] as const) {
    const { argv } = await argvOf(role, 'gn');
    assert.equal(argv[argv.indexOf('-s') + 1], want, `vai ${role}`);
    assert.ok(!argv.includes('danger-full-access'), 'danger-full-access gỡ CẢ HAI lớp lá chắn');
  }
});

test('provider tuỳ chỉnh luôn khai wire_api responses và đủ bốn khoá', async () => {
  const { argv } = await argvOf('coder', 'gn');
  assert.ok(argv.includes('model_providers.gn.wire_api="responses"'));
  assert.ok(!argv.some((a) => a.includes('wire_api="chat"')), 'chat đã bị Codex gỡ bỏ');
  for (const k of ['name', 'base_url', 'env_key']) {
    assert.ok(argv.some((a) => a.startsWith(`model_providers.gn.${k}=`)), `thiếu ${k}`);
  }
  assert.ok(argv.includes('model_provider="gn"'));
});

test('provider openai dựng sẵn thì không sinh cờ -c nào', async () => {
  const { argv } = await argvOf('coder', null);
  assert.ok(!argv.includes('-c'));
  assert.equal(argv[argv.indexOf('-m') + 1], 'm2');
});

test('CODEX_HOME trỏ guard home, PATH được nối thêm chứ không thay thế', async () => {
  const { body } = await argvOf('coder', 'gn');
  assert.match(body, /CODEX_HOME=.*codex-home/);
  assert.ok(!/CODEX_HOME=[^\n]*\/\.codex$/.test(body), 'không được trỏ vào ~/.codex của người dùng');
  const path = body.split('PATH=')[1].split('\n')[0];
  assert.ok(path.startsWith(process.env.PATH ?? ''), 'PATH cha phải còn nguyên ở đầu');
  assert.ok(path.includes('/usr/bin'), 'phải nối thêm thư mục chuẩn');
});

test('runner claude đặt prompt ngay sau -p để --tools không nuốt mất', async () => {
  chmodSync(RECORD, 0o755);
  const dir = mkdtempSync(join(tmpdir(), 'mcg-cl-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify({
    binaries: { codex: FAKE, claude: RECORD },
    roles: {
      splitter: { runner: 'claude', model: 'sonnet', effort: 'xhigh' },
      reviewer: { runner: 'claude', model: 'sonnet' },
      coder: { runner: 'codex', model: 'm' },
    },
  }));
  const rec = join(dir, 'rec.txt');
  process.env.RECORD_TO = rec;
  await runRole('splitter', loadConfig(p), {
    prompt: 'xin chao', cwd: dir, guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
  });
  delete process.env.RECORD_TO;
  const argv = readFileSync(rec, 'utf8').split('ARGV_BEGIN\n')[1].split('\nARGV_END')[0].split('\n');
  assert.equal(argv[0], '-p');
  assert.equal(argv[1], 'xin chao', 'prompt phải đứng ngay sau -p');
  assert.equal(argv[argv.length - 1], 'Read,Grep,Glob', '--tools biến thiên nên phải ở cuối');
  assert.ok(argv.includes('--effort') && argv.includes('xhigh'));
});

test('spawn hỏng thì resolve chứ không làm sập tiến trình MCP', async () => {
  const { cfg, dir } = cfgWith();
  const r = await runRole('coder', cfg, {
    prompt: 'x', cwd: join(dir, 'thu-muc-khong-ton-tai'),
    guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
  });
  assert.equal(r.exitCode, -1);
  assert.match(r.stderr, /ENOENT|spawn/i);
});

test('outFile của lượt trước bị xoá, không bị đọc nhầm thành kết quả lượt này', async () => {
  chmodSync(FAKE, 0o755);
  const { cfg, dir } = cfgWith();
  const out = join(dir, 'o.txt');
  writeFileSync(out, 'KET-QUA-CU');
  // Phải dùng child KHÔNG ghi -o, nếu không fixture sẽ ghi đè và test xanh kể cả khi
  // bỏ rmSync — tức là chẳng ghim được gì.
  process.env.FAKE_NO_WRITE = '1';
  process.env.FAKE_EXIT = '1';
  const r = await runRole('coder', cfg, {
    prompt: 'x', cwd: dir, guardHome: ensureGuardHome(dir), outFile: out,
  });
  delete process.env.FAKE_NO_WRITE;
  delete process.env.FAKE_EXIT;
  assert.equal(r.lastMessage, '', 'phải rỗng, không được là kết quả lượt trước');
});

test('văn bản tiếng Việt dài không bị hỏng ở ranh giới chunk', async () => {
  chmodSync(FAKE, 0o755);
  const { cfg, dir } = cfgWith();
  process.env.FAKE_BIG_UTF8 = '5000'; // ~305KB thật, vượt nhiều lần ngưỡng chunk 64KB
  const r = await runRole('coder', cfg, {
    prompt: 'x', cwd: dir, guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
  });
  delete process.env.FAKE_BIG_UTF8;
  assert.ok(r.stdout.length > 100000, `chỉ nhận được ${r.stdout.length} ký tự`);
  assert.ok(!r.stdout.includes('\uFFFD'), 'có ký tự hỏng — decode từng chunk rời');
  assert.ok(!r.stderr.includes('\uFFFD'), 'stderr cũng phải setEncoding');
  assert.match(r.stdout, /ăâêôơưđ ÀÁẠẢÃ/);
});

// Hai test dưới đây ghim chính tính chất an toàn: agent có quyền ghi file không được
// phép sống sót thành mồ côi sau khi hết giờ. Thiếu chúng, bỏ `detached` hay đổi
// process.kill(-pid) về child.kill() sẽ không làm đỏ bất cứ thứ gì.

test('quá giờ thì giết cả NHÓM — cháu trong nhóm không được sống sót', async () => {
  chmodSync(FAKE, 0o755);
  const { cfg, dir } = cfgWith({ timeouts: { splitter: 1, reviewer: 1, coder: 1 } });
  const pidFile = join(dir, 'gc.pid');
  process.env.FAKE_GRANDCHILD_PIDFILE = pidFile;
  const started = Date.now();
  const r = await runRole('coder', cfg, {
    prompt: 'x', cwd: dir, guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
  });
  delete process.env.FAKE_GRANDCHILD_PIDFILE;
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 3000);
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  await new Promise((res) => setTimeout(res, 300)); // nhường nhịp cho kernel dọn
  assert.throws(
    () => process.kill(pid, 0),
    /ESRCH/,
    `cháu pid ${pid} còn sống — group kill hỏng, agent ghi file thành mồ côi`,
  );
});

test('cháu tự thoát nhóm mà giữ pipe thì vẫn không kéo dài quá hạn', async () => {
  chmodSync(FAKE, 0o755);
  const { cfg, dir } = cfgWith({ timeouts: { splitter: 1, reviewer: 1, coder: 1 } });
  process.env.FAKE_ESCAPED_NODE = process.execPath;
  const started = Date.now();
  const r = await runRole('coder', cfg, {
    prompt: 'x', cwd: dir, guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
  });
  delete process.env.FAKE_ESCAPED_NODE;
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 3000, 'huỷ pipe phía ta không hoạt động');
});
```

- [ ] **Step 4: Chạy test để xác nhận nó hỏng**

Chạy: `npm test`
Kỳ vọng: FAIL với `Cannot find module '../src/runner.ts'`

- [ ] **Step 5: Viết src/runner.ts**

```ts
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROLE_SANDBOX, type Config, type Role } from './config.ts';

/**
 * Lá chắn git có HAI lớp độc lập, cả hai đã xác minh bằng cách chạy codex thật:
 *
 * 1. execpolicy `decision="forbidden"` — chặn dạng gọi thông thường, kèm thông báo rõ
 *    ("rejected by the execution environment with the reason `no commit`"). Lớp này
 *    KHÔNG phủ được dạng có tuỳ chọn toàn cục: `git -c user.name=a commit` và
 *    `git -C . commit` không khớp prefix rule (execpolicy check trả matchedRules rỗng).
 * 2. sandbox `workspace-write` — từ chối mọi ghi vào .git bất kể argv dạng gì:
 *    "fatal: Unable to create '.../.git/index.lock': Operation not permitted".
 *    Đây mới là chốt chặn thật.
 *
 * Vì thế `-s workspace-write` là bắt buộc: `danger-full-access` gỡ CẢ HAI lớp cùng lúc.
 */
export const GUARD_RULES =
  'prefix_rule(pattern=["git","commit"], decision="forbidden", justification="Pipeline agent must not commit.")\n' +
  'prefix_rule(pattern=["git","push"], decision="forbidden", justification="Pipeline agent must not push.")\n';

/**
 * CODEX_HOME riêng là điểm mấu chốt: lá chắn chỉ áp lên tiến trình con,
 * không đụng phiên Codex của chính người dùng.
 */
export function ensureGuardHome(root: string = join(homedir(), '.mcp-coding-glm')): string {
  const home = join(root, 'codex-home');
  mkdirSync(join(home, 'rules'), { recursive: true });
  writeFileSync(join(home, 'rules', 'guard.rules'), GUARD_RULES);
  return home;
}

export type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  lastMessage: string;
  timedOut: boolean;
};

export type RunOpts = {
  prompt: string;
  cwd: string;
  guardHome: string;
  outFile: string;
  onSpawn?: (child: ChildProcess) => void;
};

export function runRole(role: Role, cfg: Config, opts: RunOpts): Promise<RunResult> {
  const rc = cfg.roles[role];
  const timeoutMs = cfg.timeouts[role] * 1000;

  // Kế thừa env rồi ghi đè thứ quan trọng. App GUI có env nghèo nàn, nên ta BỔ SUNG
  // các thư mục chuẩn vào PATH thay vì thay thế — tiến trình con vẫn cần tìm được
  // git, node và trình chạy test của dự án.
  const PATH_EXTRA = '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [process.env.PATH, PATH_EXTRA].filter(Boolean).join(':'),
  };

  let bin: string;
  const args: string[] = [];

  if (rc.runner === 'codex') {
    bin = cfg.binaries.codex;
    args.push(
      'exec', '--skip-git-repo-check',
      '-C', opts.cwd,
      '-s', ROLE_SANDBOX[role],
      '--json',
      '-o', opts.outFile,
      '-m', rc.model,
    );
    if (rc.provider && rc.provider !== 'openai') {
      const p = cfg.providers[rc.provider];
      args.push(
        '-c', `model_provider="${rc.provider}"`,
        '-c', `model_providers.${rc.provider}.name="${rc.provider}"`,
        '-c', `model_providers.${rc.provider}.base_url="${p.baseUrl}"`,
        '-c', `model_providers.${rc.provider}.env_key="${p.apiKeyEnv}"`,
        '-c', `model_providers.${rc.provider}.wire_api="${p.wireApi}"`,
      );
      env[p.apiKeyEnv] = process.env[p.apiKeyEnv] ?? '';
    }
    args.push(opts.prompt);
    env.CODEX_HOME = opts.guardHome;
  } else {
    bin = cfg.binaries.claude!;
    // Prompt phải đứng NGAY SAU -p. `--tools <tools...>` của Claude Code là biến thiên,
    // nên bất cứ thứ gì đứng sau nó đều bị nuốt thành tên tool, và CLI thật báo
    // "Input must be provided either through stdin or as a prompt argument".
    args.push('-p', opts.prompt, '--model', rc.model, '--output-format', 'json',
              '--add-dir', opts.cwd);
    if (rc.effort) args.push('--effort', rc.effort);
    args.push('--tools', 'Read,Grep,Glob'); // đặt CUỐI vì biến thiên
  }

  // Đọc lại outFile của lượt trước sẽ cho ra lastMessage cũ nếu lượt này không ghi được.
  rmSync(opts.outFile, { force: true });

  return new Promise<RunResult>((resolve) => {
    // detached: con thành trưởng nhóm tiến trình, nhờ đó giết được CẢ cháu. Không có nó
    // thì SIGKILL chỉ tới `sh`, còn `sleep` cháu vẫn giữ pipe stdout và 'close' phải đợi
    // nó — đo thật: hạn 1s nhưng settle ở 8,0s.
    const child = spawn(bin, args, {
      cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    opts.onSpawn?.(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      // Một đứa cháu tự setsid ra khỏi nhóm vẫn giữ pipe và 'close' vẫn phải đợi nó —
      // đo thật 8,5s cho hạn 1s. Huỷ pipe ở phía ta để thoát hẳn, bất kể nó còn sống.
      child.stdout.destroy();
      child.stderr.destroy();
    }, timeoutMs);

    // setEncoding thay vì String(d) từng chunk: ký tự nhiều byte bị cắt ngang ranh giới
    // chunk sẽ thành U+FFFD — đo thật 7 ký tự hỏng trên 300KB tiếng Việt.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    // Không có handler này, spawn hỏng (cwd không tồn tại, EACCES, ENOENT) ném
    // "Unhandled 'error' event" và GIẾT CẢ TIẾN TRÌNH MCP, promise không bao giờ settle.
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: stderr + String(e), lastMessage: '', timedOut });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let lastMessage = '';
      try {
        lastMessage = readFileSync(opts.outFile, 'utf8');
      } catch {
        // chưa ghi được file; rơi xuống đọc stdout
      }
      if (!lastMessage && rc.runner === 'claude') {
        try {
          lastMessage = String(JSON.parse(stdout).result ?? '');
        } catch {
          lastMessage = stdout;
        }
      }
      resolve({ exitCode: code ?? -1, stdout, stderr, lastMessage, timedOut });
    });
  });
}
```

- [ ] **Step 6: Chạy test để xác nhận đã xanh**

Chạy: `chmod +x test/fixtures/fake-codex.sh test/fixtures/record-exec.sh && npm test`
Kỳ vọng: PASS. Test lá chắn git **phải chạy thật**, không được `skip`, vì nó tự giải binary
`codex` từ `CODEX_BIN` hoặc PATH chứ không phụ thuộc config của người dùng. Nếu máy không có
`codex` thì mới skip.

- [ ] **Step 7: Commit**

```bash
git add src/runner.ts test/runner.test.ts test/guard.test.ts \
        test/fixtures/fake-codex.sh test/fixtures/record-exec.sh
git commit -m "feat: subprocess runner with isolated CODEX_HOME git guard and timeouts"
```

---

### Task 4: Kho job — khoá theo cwd, thư mục log, huỷ

**Files:**
- Create: `src/jobs.ts`, `test/jobs.test.ts`

**Interfaces:**
- Consumes: (không phụ thuộc task trước)
- Produces:
  - `type JobState = 'queued'|'splitting'|'running'|'done'|'failed'|'cancelled'`
  - `type TaskState = 'pending'|'coding'|'reviewing'|'passed'|'needs_human'|'timeout'|'failed'`
  - `type Job = { id, cwd, state, plan, tasks, current, error, dir, children }`
  - `createJob(plan: string, cwd: string, root?: string): Job` — ném Error nếu `cwd` đang có job chạy
  - `getJob(id: string): Job | undefined`
  - `appendEvent(job: Job, event: Record<string, unknown>): void`
  - `readTail(job: Job, n: number): string[]`
  - `cancelJob(id: string): boolean`
  - `releaseJob(job: Job): void` — gỡ khoá cwd khi job kết thúc

- [ ] **Step 1: Viết test thất bại**

`test/jobs.test.ts`:

```ts
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
```

- [ ] **Step 2: Chạy test để xác nhận nó hỏng**

Chạy: `npm test`
Kỳ vọng: FAIL với `Cannot find module '../src/jobs.ts'`

- [ ] **Step 3: Viết src/jobs.ts**

```ts
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TaskItem, Review } from './contract.ts';

export type JobState = 'queued' | 'splitting' | 'running' | 'done' | 'failed' | 'cancelled';
export type TaskState =
  | 'pending' | 'coding' | 'reviewing' | 'passed' | 'needs_human' | 'timeout' | 'failed';

export type JobTask = {
  item: TaskItem;
  state: TaskState;
  round: number;
  lastReview?: Review;
};

export type Job = {
  id: string;
  cwd: string;          // đã chuẩn hoá — xem createJob
  lockFile: string;
  plan: string;
  state: JobState;
  tasks: JobTask[];
  current: string | null;
  error: string | null;
  dir: string;
  children: Set<ChildProcess>;
};

const jobs = new Map<string, Job>();
const cwdLock = new Map<string, string>(); // cwd -> jobId

export function createJob(
  plan: string,
  cwd: string,
  root: string = join(homedir(), '.mcp-coding-glm'),
): Job {
  // Khoá theo đường dẫn ĐÃ CHUẨN HOÁ. Khoá theo chuỗi thô thì "/tmp/x", "/tmp/x/",
  // "/private/tmp/x" và symlink trỏ tới nó là bốn khoá khác nhau cho cùng một thư mục
  // — đã thử 7 cách viết, cả 7 đều mở được job thứ hai trên cùng chỗ.
  let key = resolve(cwd);
  try {
    key = realpathSync.native(key);
  } catch {
    // thư mục chưa tồn tại: dạng resolve vẫn tốt hơn chuỗi thô
  }

  const holder = cwdLock.get(key);
  if (holder) {
    throw new Error(`A job is already running for ${key}: ${holder}. Cancel it first.`);
  }

  // Khoá LIÊN TIẾN TRÌNH. Map chỉ sống trong một tiến trình, mà người dùng có thể mở
  // Codex CLI và Codex Desktop cùng lúc — mỗi bên spawn một MCP server riêng, không
  // thấy Map của nhau. Hai agent sửa cùng một thư mục tại chỗ, không commit, là mất
  // việc không cứu lại được.
  const lockDir = join(root, 'locks');
  const lockFile = join(lockDir, encodeURIComponent(key) + '.lock');
  mkdirSync(lockDir, { recursive: true });
  if (existsSync(lockFile)) {
    try {
      const prev = JSON.parse(readFileSync(lockFile, 'utf8')) as { pid: number; jobId: string };
      let alive = false;
      try {
        process.kill(prev.pid, 0);
        alive = true;
      } catch {
        alive = false; // tiến trình giữ khoá đã chết — khoá mồ côi, chiếm lại
      }
      if (alive && prev.pid !== process.pid) {
        throw new Error(
          `Another mcp-coding-glm process (pid ${prev.pid}) holds ${key} for job ${prev.jobId}.`,
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Another mcp-coding-glm')) throw e;
      // khoá file hỏng định dạng: coi như mồ côi
    }
  }

  const id = randomUUID();
  const dir = join(root, 'jobs', id);
  // Mọi I/O có thể hỏng phải chạy TRƯỚC khi ghi vào Map. Đăng ký xong rồi mới hỏng thì
  // khoá kẹt vĩnh viễn mà không có Job nào để mà huỷ.
  mkdirSync(dir, { recursive: true });
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, jobId: id }));

  const job: Job = {
    id, cwd: key, lockFile, plan, state: 'queued', tasks: [], current: null, error: null, dir,
    children: new Set(),
  };
  jobs.set(id, job);
  cwdLock.set(key, id);
  appendEvent(job, { type: 'job.created', cwd: key });
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function appendEvent(job: Job, event: Record<string, unknown>): void {
  // Best-effort: ghi log hỏng không được phép làm hỏng job. Trước đây một lần ghi hỏng
  // sẽ ném ra giữa cancelJob, khiến khoá không bao giờ được nhả và mọi lần thử lại
  // đều ném cho tới khi khởi động lại server.
  // `t` đặt SAU phần spread để sự kiện không thể tự ghi đè dấu thời gian.
  try {
    appendFileSync(join(job.dir, 'events.jsonl'), JSON.stringify({ ...event, t: Date.now() }) + '\n');
  } catch {
    // nuốt: không có chỗ nào an toàn để báo, và mất một dòng log không đáng mất cả job
  }
}

export function readTail(job: Job, n: number): string[] {
  const p = join(job.dir, 'events.jsonl');
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-n);
}

export function releaseJob(job: Job): void {
  if (cwdLock.get(job.cwd) !== job.id) return; // job khác đã chiếm khoá: không đụng vào
  cwdLock.delete(job.cwd);
  try {
    rmSync(job.lockFile, { force: true });
  } catch {
    // không xoá được: lần sau sẽ thấy pid đã chết và chiếm lại
  }
}

const TERMINAL: ReadonlySet<JobState> = new Set(['done', 'failed', 'cancelled']);

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  // Job đã kết thúc thì huỷ là vô nghĩa: ghi đè `done` thành `cancelled` khiến
  // pipeline_result báo công việc đã hoàn thành là đã bị huỷ.
  if (TERMINAL.has(job.state)) return false;
  for (const c of job.children) {
    // Giết theo NHÓM, giống hệt đường timeout trong runner.ts. `c.kill()` chỉ tới con
    // trực tiếp: cháu vẫn sống, vẫn giữ pipe, và một coder có quyền ghi file sẽ chạy
    // tiếp như mồ côi. Đo thật trên đường timeout: 6232ms so với 505ms.
    // `onSpawn` bắn cả khi spawn hỏng, nên pid có thể undefined.
    // Không có pid (spawn hỏng): `c.kill()` ở đây gửi tín hiệu tới pid 0, tức CẢ NHÓM
    // tiến trình của chính MCP server. Bỏ qua là lựa chọn duy nhất an toàn.
    if (!c.pid) continue;
    try {
      process.kill(-c.pid, 'SIGKILL');
    } catch {
      c.kill('SIGKILL');
    }
    c.stdout?.destroy();
    c.stderr?.destroy();
  }
  job.children.clear();
  job.state = 'cancelled';
  // Nhả khoá TRƯỚC khi ghi log: ghi log hỏng không được giữ khoá lại.
  releaseJob(job);
  appendEvent(job, { type: 'job.cancelled' });
  return true;
}
```

- [ ] **Step 4: Chạy test để xác nhận đã xanh**

Chạy: `npm test`
Kỳ vọng: PASS, thêm 10 test

- [ ] **Step 5: Commit**

```bash
git add src/jobs.ts test/jobs.test.ts
git commit -m "feat: job store with cwd lock, event log and cancellation"
```

---

### Task 5: Máy trạng thái pipeline

**Files:**
- Create: `src/pipeline.ts`, `test/pipeline.test.ts`

**Interfaces:**
- Consumes: `loadConfig`/`Config` (Task 1), `parseContract`/`TaskListSchema`/`ReviewSchema` (Task 2), `runRole`/`ensureGuardHome` (Task 3), kho job (Task 4)
- Produces:
  - `runPipeline(job: Job, cfg: Config, opts?: { dryRun?: boolean; only?: string[]; maxRounds?: number }): Promise<void>`

Prompt template là hằng ở đầu file này, không tách module riêng — mỗi prompt chỉ phục vụ đúng một bước.

- [ ] **Step 1: Viết test thất bại**

`test/pipeline.test.ts`:

```ts
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
  execFileSync('git', ['init'], { cwd: dir });
  writeFileSync(join(dir, 'chua-theo-doi.txt'), 'noi dung');

  const job = createJob('ke hoach', dir);
  await runPipeline(job, cfg);

  const taskDir = join(job.dir, 'task-1');
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
```

- [ ] **Step 2: Tạo binary giả có kịch bản**

`test/fixtures/scripted-codex.sh` (nhớ `chmod +x`):

```bash
#!/bin/sh
# Trả phản hồi thứ N từ FAKE_SCRIPT_DIR, tăng bộ đếm sau mỗi lần gọi, và GHI LẠI từng
# lượt vào calls.log để test khẳng định được prompt và sandbox — bản cũ bỏ qua argv nên
# test không thể bắt được việc gọi thừa hay prompt sai.
#   FAKE_HOLD_ON=<n>  giữ lượt thứ n lại (để test huỷ đúng điểm await)
#   FAKE_HOLD         giữ bao lâu, mặc định 10s
#   FAKE_TOUCH        tạo file mới ở đường dẫn này (để test diff thấy file mới)
out=""
prev=""
sandbox=""
prompt=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  if [ "$prev" = "-s" ]; then sandbox="$a"; fi
  prompt="$a"
  prev="$a"
done
d="$FAKE_SCRIPT_DIR"
n=$(cat "$d/counter" 2>/dev/null || echo 0)
body=$(cat "$d/$n.txt" 2>/dev/null || echo '')
echo $((n + 1)) > "$d/counter"
{ echo "CALL $n sandbox=$sandbox"; echo "$prompt"; echo "==="; } >> "$d/calls.log"
if [ -n "$FAKE_TOUCH" ]; then echo 'noi dung moi' > "$FAKE_TOUCH"; fi
if [ "$FAKE_HOLD_ON" = "$n" ]; then sleep "${FAKE_HOLD:-10}"; fi
echo '{"type":"item.completed"}'
if [ -n "$out" ]; then printf '%s' "$body" > "$out"; fi
exit 0
```

- [ ] **Step 3: Chạy test để xác nhận nó hỏng**

Chạy: `npm test`
Kỳ vọng: FAIL với `Cannot find module '../src/pipeline.ts'`

- [ ] **Step 4: Viết src/pipeline.ts**

```ts
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Config } from './config.ts';
import { parseContract, TaskListSchema, ReviewSchema, type Review } from './contract.ts';
import { runRole, ensureGuardHome } from './runner.ts';
import { appendEvent, releaseJob, type Job } from './jobs.ts';

const JSON_ONLY = 'Reply with JSON only. No prose. No markdown fences.';

const SPLIT_PROMPT = (plan: string) => `You are a task splitter for a coding pipeline.

Break the plan below into the smallest independent tasks that each change code and can be
verified on their own. Order them so that each task only depends on earlier ones.

PLAN:
${plan}

Return this exact shape:
{"tasks":[{"id":"1","title":"...","detail":"...","files":["..."],"acceptance":"..."}]}

"detail" must be complete enough to implement without re-reading the plan.
"acceptance" must state how to tell the task is done.
${JSON_ONLY}`;

const CODE_PROMPT = (t: { title: string; detail: string; acceptance: string }, guidance: string) =>
  `Implement this task in the current repository.

TITLE: ${t.title}
DETAIL: ${t.detail}
DONE WHEN: ${t.acceptance}
${guidance ? `\nThe previous attempt was rejected. Fix exactly this:\n${guidance}\n` : ''}
Write the code and run the project's tests if a test command exists.
You must NOT run "git commit" or "git push" — they are blocked and will fail.
Reply with a short summary of what you changed.`;

const REVIEW_PROMPT = (t: { title: string; acceptance: string }, diff: string) =>
  `You are reviewing one task of a coding pipeline.

TASK: ${t.title}
DONE WHEN: ${t.acceptance}

DIFF:
${diff || '(no changes were made)'}

Judge only whether this diff satisfies the task. Return this exact shape:
{"verdict":"pass","issues":[],"guidance":""}
or
{"verdict":"fail","issues":[{"severity":"blocker","file":"a.ts","line":1,"message":"..."}],"guidance":"what to change next round"}
${JSON_ONLY}`;

/**
 * Chụp toàn bộ cây làm việc thành một git tree object. Đây là lưới an toàn DUY NHẤT của
 * thiết kế này (sửa tại chỗ + cấm commit), nên nó phải thấy được mọi thứ.
 *
 * Vì sao không dùng `git diff` trần — đã đo, cả bốn ca đều hỏng im lặng:
 *   - task chỉ TẠO FILE MỚI  -> diff 0 byte, reviewer bị bảo "(no changes were made)"
 *   - repo có file nhị phân  -> `git apply -R` từ chối CẢ bản vá, kể cả hunk văn bản
 *   - user đặt color.ui=always hay diff.noprefix -> bản vá vô dụng
 *   - diff vượt maxBuffer    -> 0 byte, không sự kiện, không lỗi
 *
 * Dùng GIT_INDEX_FILE tạm: `git add -A` ghi vào index TẠM đó rồi `write-tree` biến nó
 * thành tree. Index, status và ref thật không bị đụng; chỉ sinh object không ai tham
 * chiếu, `git gc` sẽ dọn. Trả null khi cwd không phải git work tree.
 */
function snapshotTree(cwd: string): string | null {
  const idx = join(tmpdir(), `mcg-idx-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    execFileSync('git', ['add', '-A'], { cwd, env, stdio: ['ignore', 'ignore', 'ignore'] });
    return execFileSync('git', ['write-tree'], {
      cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null; // không phải repo git, hoặc git không chạy được
  } finally {
    rmSync(idx, { force: true });
  }
}

export async function runPipeline(
  job: Job,
  cfg: Config,
  opts: { dryRun?: boolean; only?: string[]; maxRounds?: number } = {},
): Promise<void> {
  // Clamp: maxRounds = 0 hay NaN khiến mọi task đứng yên ở 'pending' mà job vẫn báo 'done'.
  const asked = opts.maxRounds ?? cfg.maxRounds;
  const maxRounds = Number.isFinite(asked) && asked >= 1 ? Math.min(Math.floor(asked), 10) : 1;

  try {
    // PHẢI nằm trong try: ném ra ngoài đây thì job kẹt ở 'queued', khoá không bao giờ
    // được nhả, và `void runPipeline(...)` ở index.ts làm sập cả tiến trình MCP.
    const guardHome = ensureGuardHome();

    // Không phải repo git thì KHÔNG có lưới an toàn nào. Báo to ngay, đừng để người dùng
    // phát hiện lúc cần lùi lại.
    if (snapshotTree(job.cwd) === null) {
      job.state = 'failed';
      job.error =
        `${job.cwd} is not a git work tree. This pipeline edits in place and never commits, ` +
        `so a git repository is the only way to recover. Run \`git init\` first.`;
      appendEvent(job, { type: 'job.failed', error: job.error });
      return;
    }
    // ---------- SPLIT ----------
    job.state = 'splitting';
    let splitPrompt = SPLIT_PROMPT(job.plan);
    let tasks = null as null | ReturnType<typeof TaskListSchema.parse>;

    for (let attempt = 1; attempt <= 3; attempt++) {
      appendEvent(job, { type: 'split.attempt', attempt });
      const r = await runRole('splitter', cfg, {
        prompt: splitPrompt, cwd: job.cwd, guardHome,
        outFile: join(job.dir, `split-${attempt}.txt`),
        onSpawn: (c) => { job.children.add(c); c.on('close', () => job.children.delete(c)); },
      });
      // Huỷ giữa chừng: cancelJob đã giết con và nhả khoá. Không thoát ở đây thì
      // coroutine này đi tiếp và spawn con workspace-write MỚI sau khi người dùng đã
      // thấy "Cancelled" — và một job khác có thể đang giữ khoá thư mục đó rồi.
      if (job.state === 'cancelled') return;
      const parsed = parseContract(r.lastMessage, TaskListSchema);
      if (parsed.ok) { tasks = parsed.value; break; }
      writeFileSync(join(job.dir, `split-${attempt}.stderr`), r.stderr);
      appendEvent(job, {
        type: 'split.invalid', attempt, code: r.exitCode, reason: parsed.repairPrompt,
      });
      splitPrompt = `${SPLIT_PROMPT(job.plan)}\n\n${parsed.repairPrompt}`;
    }

    if (!tasks) {
      job.state = 'failed';
      job.error = 'split failed: splitter did not return valid JSON after 3 attempts';
      appendEvent(job, { type: 'job.failed', error: job.error });
      return;
    }

    job.tasks = tasks.tasks
      .filter((item) => !opts.only || opts.only.includes(item.id))
      .map((item) => ({ item, state: 'pending' as const, round: 0 }));
    appendEvent(job, { type: 'split.done', count: job.tasks.length });
    if (job.tasks.length === 0) {
      job.state = 'failed';
      job.error = opts.only
        ? `No task matched only=[${opts.only.join(', ')}]`
        : 'Splitter returned an empty task list';
      appendEvent(job, { type: 'job.failed', error: job.error });
      return;
    }

    if (opts.dryRun) {
      job.state = 'done';
      appendEvent(job, { type: 'job.done', dryRun: true });
      return;
    }

    // ---------- CODE → REVIEW → FIX ----------
    job.state = 'running';
    for (const [idx, t] of job.tasks.entries()) {
      job.current = t.item.id;
      // Tên theo VỊ TRÍ, không theo id: hai task trùng id — hoặc "A" và "a" trên APFS
      // không phân biệt hoa thường — sẽ dùng chung một thư mục log và ghi đè nhau.
      const taskDir = join(job.dir, `task-${idx + 1}-${t.item.id}`);
      mkdirSync(taskDir, { recursive: true });

      // Mốc gốc của task: chụp cây TRƯỚC khi coder động vào bất cứ thứ gì.
      const treeBefore = snapshotTree(job.cwd);
      writeFileSync(join(taskDir, 'baseline.tree'), String(treeBefore));

      // git diff không nhìn thấy file chưa từng được theo dõi; chép lại trước khi bị ghi đè.
      if (cfg.snapshotUntracked) {
        const snapDir = join(taskDir, 'untracked-before');
        mkdirSync(snapDir, { recursive: true });
        let untracked: string[] = [];
        try {
          // -z: không có nó, git bọc tên có dấu hoặc dấu nháy trong "..." và ta bỏ sót
          // im lặng — đã đo: 'chưa-theo-dõi.txt' bị bỏ qua mà vẫn báo đã chép.
          untracked = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], {
            cwd: job.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
          }).split('\0').filter(Boolean);
        } catch {
          // không phải repo git — không có gì để liệt kê
        }
        for (const rel of untracked) {
          const dest = join(snapDir, rel);
          mkdirSync(dirname(dest), { recursive: true });
          try {
            copyFileSync(join(job.cwd, rel), dest);
          } catch {
            // file không đọc được thì bỏ qua, không làm hỏng cả job
          }
        }
        appendEvent(job, { type: 'task.snapshot', id: t.item.id, files: untracked.length });
      }

      let guidance = '';

      for (let round = 1; round <= maxRounds; round++) {
        t.round = round;

        t.state = 'coding';
        appendEvent(job, { type: 'task.coding', id: t.item.id, round });
        const coded = await runRole('coder', cfg, {
          prompt: CODE_PROMPT(t.item, guidance), cwd: job.cwd, guardHome,
          outFile: join(taskDir, `round-${round}.msg`),
          onSpawn: (c) => { job.children.add(c); c.on('close', () => job.children.delete(c)); },
        });
        if (job.state === 'cancelled') return;
        writeFileSync(join(taskDir, `round-${round}.stdout`), coded.stdout);
        // Giữ cả stderr và mã thoát: không có chúng, một agent thoát 1 vì
        // "401 Unauthorized" chỉ hiện ra thành "did not return valid JSON".
        writeFileSync(join(taskDir, `round-${round}.stderr`), coded.stderr);
        appendEvent(job, { type: 'coder.exit', id: t.item.id, round, code: coded.exitCode });

        // Chụp TRƯỚC khi xử lý timeout: coder hết giờ vẫn có thể đã sửa dở file, và đó
        // chính là lúc cần bản vá để lùi lại nhất.
        const treeAfter = snapshotTree(job.cwd);
        let diff = '';
        if (treeBefore && treeAfter) {
          try {
            // So hai tree -> delta ĐÚNG CỦA TASK NÀY, không lẫn việc của task trước và
            // không lẫn thay đổi người dùng đã có sẵn. --binary để bản vá dùng lại được.
            diff = execFileSync('git', [
              '-c', 'core.quotePath=false', 'diff', '--binary', '--no-color', '--no-ext-diff',
              treeBefore, treeAfter,
            ], {
              cwd: job.cwd, encoding: 'utf8',
              maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
            });
          } catch (e) {
            appendEvent(job, {
              type: 'diff.failed', id: t.item.id, round, error: (e as Error).message,
            });
          }
        }
        writeFileSync(join(taskDir, `round-${round}.diff`), diff);

        if (coded.timedOut) {
          t.state = 'timeout';
          appendEvent(job, { type: 'task.timeout', id: t.item.id, round });
          break;
        }

        t.state = 'reviewing';
        appendEvent(job, { type: 'task.reviewing', id: t.item.id, round });
        // argv của macOS chặn quanh 1MiB: một diff ~2MB làm spawn ném E2BIG, job thành
        // 'failed' và mọi task sau không bao giờ chạy. Cắt bớt, chỉ đường tới bản đầy đủ.
        const CAP = 200_000;
        const shown = diff.length > CAP
          ? `${diff.slice(0, CAP)}\n\n[... cắt bớt ${diff.length - CAP} ký tự. ` +
            `Bản đầy đủ: ${join(taskDir, `round-${round}.diff`)} ...]`
          : diff;
        let reviewPrompt = REVIEW_PROMPT(t.item, shown);
        let review: Review | null = null;

        for (let attempt = 1; attempt <= 3; attempt++) {
          const r = await runRole('reviewer', cfg, {
            prompt: reviewPrompt, cwd: job.cwd, guardHome,
            outFile: join(taskDir, `round-${round}.review-${attempt}.msg`),
            onSpawn: (c) => { job.children.add(c); c.on('close', () => job.children.delete(c)); },
          });
          if (job.state === 'cancelled') return;
          const parsed = parseContract(r.lastMessage, ReviewSchema);
          if (parsed.ok) { review = parsed.value; break; }
          appendEvent(job, { type: 'review.invalid', id: t.item.id, round, attempt });
          reviewPrompt = `${REVIEW_PROMPT(t.item, shown)}\n\n${parsed.repairPrompt}`;
        }

        if (!review) {
          t.state = 'failed';
          appendEvent(job, { type: 'task.review_unparseable', id: t.item.id, round });
          break;
        }

        t.lastReview = review;
        writeFileSync(join(taskDir, `round-${round}.review.json`), JSON.stringify(review, null, 2));

        if (review.verdict === 'pass') {
          t.state = 'passed';
          appendEvent(job, { type: 'task.passed', id: t.item.id, round });
          break;
        }

        guidance =
          review.guidance ||
          review.issues.map((i) => `${i.severity}: ${i.message}`).join('\n') ||
          // Không có lời nào thì prompt vòng sau sẽ y hệt vòng trước — thử mù, phí một
          // lượt agent. Ít nhất phải nói cho coder biết nó đã bị từ chối.
          'The previous attempt was rejected but the reviewer gave no reason. ' +
            'Re-read the task and verify the acceptance criterion yourself before replying.';
        appendEvent(job, { type: 'task.rejected', id: t.item.id, round, guidance });
        // Hết vòng mà vẫn fail thì cần người xem — nhưng không treo cả pipeline.
        if (round === maxRounds) {
          t.state = 'needs_human';
          appendEvent(job, { type: 'task.needs_human', id: t.item.id });
        }
      }
    }

    job.current = null;
    job.state = 'done';
    appendEvent(job, { type: 'job.done' });
  } catch (e) {
    // Bị huỷ thì giữ nguyên 'cancelled', đừng báo thành 'failed'.
    if (job.state === 'cancelled') return;
    job.state = 'failed';
    job.error = (e as Error).message;
    appendEvent(job, { type: 'job.failed', error: job.error });
  } finally {
    job.children.clear();
    releaseJob(job);
  }
}
```

- [ ] **Step 5: Chạy test để xác nhận đã xanh**

Chạy: `chmod +x test/fixtures/scripted-codex.sh && npm test`
Kỳ vọng: PASS, thêm 5 test

- [ ] **Step 6: Commit**

```bash
git add src/pipeline.ts test/pipeline.test.ts test/fixtures/scripted-codex.sh
git commit -m "feat: pipeline state machine with review rounds and diff capture"
```

---

### Task 6: Wiring MCP server

**Files:**
- Create: `src/index.ts`, `test/server.test.ts`

**Interfaces:**
- Consumes: tất cả các task trước
- Produces: 5 MCP tool — `pipeline_start`, `pipeline_status`, `pipeline_result`, `pipeline_cancel`, `capabilities`

- [ ] **Step 1: Viết test thất bại — lái server bằng JSON-RPC thật**

`test/server.test.ts`:

```ts
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
```

- [ ] **Step 2: Chạy test để xác nhận nó hỏng**

Chạy: `npm test`
Kỳ vọng: FAIL — `src/index.ts` chưa tồn tại

- [ ] **Step 3: Viết src/index.ts**

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';
import { existsSync } from 'node:fs';
import { loadConfig, DEFAULT_CONFIG_PATH, type Config } from './config.ts';
import { createJob, getJob, cancelJob, readTail } from './jobs.ts';
import { runPipeline } from './pipeline.ts';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

let cached: Config | null = null;
let configError: string | null = null;
try {
  cached = loadConfig();
} catch (e) {
  configError = (e as Error).message;
}

const server = new McpServer({ name: 'mcp-coding-glm', version: '0.1.0' });

server.registerTool(
  'capabilities',
  {
    description:
      'Report which runners, providers and models are configured for each pipeline role, ' +
      'and whether their binaries were found. Call this before pipeline_start to know who you are driving.',
    inputSchema: {},
  },
  async () => {
    if (!cached) return text(`Config not usable.\n${configError}`);
    const rows = Object.entries(cached.roles).map(([role, rc]) => {
      const bin = rc.runner === 'codex' ? cached!.binaries.codex : cached!.binaries.claude;
      return `${role}: runner=${rc.runner} model=${rc.model}` +
        `${rc.provider ? ` provider=${rc.provider}` : ''}` +
        ` binary=${bin} ${bin && existsSync(bin) ? 'OK' : 'MISSING'}`;
    });
    return text(
      [`config: ${DEFAULT_CONFIG_PATH}`, `maxRounds: ${cached.maxRounds}`, ...rows].join('\n'),
    );
  },
);

server.registerTool(
  'pipeline_start',
  {
    description:
      'Start a coding pipeline from an already-agreed plan. Returns a job_id immediately; ' +
      'the work runs in the background. ' +
      'ONLY call this when the user has explicitly invoked the $start-task skill. ' +
      'Never call it on your own initiative, even when a plan looks finished.',
    inputSchema: {
      plan: z.string().min(1).describe('The agreed plan, as text'),
      cwd: z.string().min(1).describe('Absolute path of the project directory to work in'),
      maxRounds: z.number().int().positive().optional().describe('Override code→review rounds'),
      only: z.array(z.string()).optional().describe('Run only these task ids after splitting'),
      dryRun: z.boolean().optional().describe('Split the plan and stop, without touching files'),
      roles: z
        .record(
          z.string(),
          z.object({
            runner: z.enum(['codex', 'claude']).optional(),
            provider: z.string().optional(),
            model: z.string().optional(),
            effort: z.string().optional(),
          }),
        )
        .optional()
        .describe('Partially override roles for this job only, e.g. {"coder":{"model":"z-ai/glm-5.2"}}'),
    },
  },
  async ({ plan, cwd, maxRounds, only, dryRun, roles }) => {
    if (!cached) return text(`Config not usable.\n${configError}`);

    // Ghi đè một phần cho job này; config trên đĩa không bị đụng tới.
    let effective = cached;
    if (roles) {
      effective = {
        ...cached,
        roles: {
          splitter: { ...cached.roles.splitter, ...(roles.splitter ?? {}) },
          reviewer: { ...cached.roles.reviewer, ...(roles.reviewer ?? {}) },
          coder: { ...cached.roles.coder, ...(roles.coder ?? {}) },
        },
      };
      if (effective.roles.coder.runner !== 'codex') {
        return text('roles.coder.runner must stay "codex" — the git guard only applies to the codex runner');
      }
    }

    let job;
    try {
      job = createJob(plan, cwd);
    } catch (e) {
      return text((e as Error).message);
    }
    // Chạy nền; host poll bằng pipeline_status.
    void runPipeline(job, effective, { maxRounds, only, dryRun });
    return text(JSON.stringify({ job_id: job.id, state: job.state, cwd }));
  },
);

server.registerTool(
  'pipeline_status',
  {
    description: 'Poll the progress of a running pipeline job.',
    inputSchema: {
      job_id: z.string().min(1),
      tail: z.number().int().positive().optional().describe('How many recent log lines to include'),
    },
  },
  async ({ job_id, tail }) => {
    const job = getJob(job_id);
    if (!job) return text(`No such job: ${job_id}`);
    return text(
      JSON.stringify(
        {
          state: job.state,
          current: job.current,
          error: job.error,
          tasks: job.tasks.map((t) => ({
            id: t.item.id, title: t.item.title, state: t.state, round: t.round,
          })),
          log_tail: tail ? readTail(job, tail) : undefined,
        },
        null,
        2,
      ),
    );
  },
);

server.registerTool(
  'pipeline_result',
  {
    description: 'Fetch the full result of a finished pipeline job, including per-task review notes.',
    inputSchema: { job_id: z.string().min(1) },
  },
  async ({ job_id }) => {
    const job = getJob(job_id);
    if (!job) return text(`No such job: ${job_id}`);
    return text(
      JSON.stringify(
        {
          state: job.state,
          error: job.error,
          logDir: job.dir,
          tasks: job.tasks.map((t) => ({
            id: t.item.id, title: t.item.title, state: t.state, rounds: t.round,
            files: t.item.files, review: t.lastReview ?? null,
          })),
          note: 'Nothing was committed or pushed. Review the diff and decide yourself.',
        },
        null,
        2,
      ),
    );
  },
);

server.registerTool(
  'pipeline_cancel',
  {
    description:
      'Cancel a running job. Child processes are killed; files already modified are left as they are.',
    inputSchema: { job_id: z.string().min(1) },
  },
  async ({ job_id }) => text(cancelJob(job_id) ? `Cancelled ${job_id}` : `No such job: ${job_id}`),
);

await server.connect(new StdioServerTransport());
```

- [ ] **Step 4: Chạy test để xác nhận đã xanh**

Chạy: `npm test`
Kỳ vọng: PASS, thêm 2 test

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/server.test.ts
git commit -m "feat: MCP server exposing five pipeline tools over stdio"
```

---

### Task 7: Ba skill Codex làm cửa chặn

**Files:**
- Create: `skills/start-task/SKILL.md`, `skills/start-task/agents/openai.yaml`
- Create: `skills/task-status/SKILL.md`, `skills/task-status/agents/openai.yaml`
- Create: `skills/task-stop/SKILL.md`, `skills/task-stop/agents/openai.yaml`

**Interfaces:**
- Consumes: tên 5 tool từ Task 6
- Produces: cây thư mục skill để `scripts/install.sh` copy vào `~/.codex/skills/`

- [ ] **Step 1: Viết skill start-task**

`skills/start-task/SKILL.md`:

```markdown
---
name: start-task
description: Hand an agreed plan to the coding pipeline and start it. Use only when the user explicitly asks to start the task.
---

# Start Task

The user has finished planning and wants the pipeline to begin.

1. Call `capabilities` first. Tell the user in one line which runner and model each role
   is using, so they know what they are about to drive.
2. Collect the plan that was agreed in this conversation into a single block of text.
   Include every decision made during the discussion — the pipeline cannot see this chat.
3. Call `pipeline_start` with that plan and the absolute path of the project directory.
   Pass `maxRounds`, `only` or `dryRun` only if the user named them in their invocation.
4. Report the returned `job_id` and the task list.
5. Then call `pipeline_status` and relay progress. Keep polling until the state is
   `done`, `failed` or `cancelled`, then call `pipeline_result`.

Nothing is committed or pushed. When the job finishes, tell the user to review the diff
themselves, and name any task that ended as `needs_human`, `timeout` or `failed`.
```

`skills/start-task/agents/openai.yaml`:

```yaml
interface:
  display_name: "Start Coding Task"
  short_description: "Hand the agreed plan to the coding pipeline"
  default_prompt: "Use $start-task to hand the plan we agreed on to the coding pipeline."

policy:
  allow_implicit_invocation: false
```

- [ ] **Step 2: Viết skill task-status**

`skills/task-status/SKILL.md`:

```markdown
---
name: task-status
description: Report the progress of a running coding pipeline job.
---

# Task Status

Call `pipeline_status` with the `job_id` from this conversation and `tail: 30`.

Report, in this order: the job state, which task is running now, each task with its state
and round number, and anything notable from the log tail.

If the state is `done`, `failed` or `cancelled`, call `pipeline_result` instead and
summarise the outcome per task.
```

`skills/task-status/agents/openai.yaml`:

```yaml
interface:
  display_name: "Coding Task Status"
  short_description: "Show progress of the running pipeline"
  default_prompt: "Use $task-status to show how the coding pipeline is doing."

policy:
  allow_implicit_invocation: true
```

- [ ] **Step 3: Viết skill task-stop**

`skills/task-stop/SKILL.md`:

```markdown
---
name: task-stop
description: Stop a running coding pipeline job. Use only when the user explicitly asks to stop.
---

# Task Stop

Call `pipeline_cancel` with the `job_id` from this conversation.

Then tell the user plainly: child processes were killed, and **files already modified were
left exactly as they are** — nothing was reverted, nothing was committed. Advise them to
check `git diff` before continuing.
```

`skills/task-stop/agents/openai.yaml`:

```yaml
interface:
  display_name: "Stop Coding Task"
  short_description: "Cancel the running pipeline job"
  default_prompt: "Use $task-stop to cancel the running coding pipeline."

policy:
  allow_implicit_invocation: false
```

- [ ] **Step 4: Kiểm frontmatter đọc được**

Chạy:

```bash
for f in skills/*/SKILL.md; do head -4 "$f"; echo "---- $f"; done
for f in skills/*/agents/openai.yaml; do grep -H allow_implicit_invocation "$f"; done
```

Kỳ vọng: mỗi `SKILL.md` có `name:` và `description:`; `start-task` và `task-stop` là `false`, `task-status` là `true`.

- [ ] **Step 5: Commit**

```bash
git add skills/
git commit -m "feat: three Codex skills gating pipeline invocation"
```

---

### Task 8: Script cài + smoke test thật

**Files:**
- Create: `scripts/install.sh`, `docs/smoke-test.md`

**Interfaces:**
- Consumes: mọi thứ phía trước
- Produces: lệnh cài một bước; quy trình smoke test tầng 3

- [ ] **Step 1: Viết scripts/install.sh**

```bash
#!/bin/sh
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
CONFIG_DIR="$HOME/.mcp-coding-glm"
SKILLS_DIR="$HOME/.codex/skills"

if [ -z "$NODE_BIN" ]; then echo "node not found on PATH"; exit 1; fi

# 1. Thư mục config + mẫu, nếu chưa có
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/config.json" ]; then
  cat > "$CONFIG_DIR/config.json" <<JSON
{
  "binaries": {
    "codex": "$(command -v codex || echo /path/to/codex)"
  },
  "providers": {
    "greennode": {
      "baseUrl": "https://tokenplan.api.greennode.ai/v1",
      "apiKeyEnv": "GREENNODE_API_KEY"
    }
  },
  "roles": {
    "splitter": { "runner": "codex", "provider": "openai", "model": "gpt-5.6-sol", "effort": "xhigh" },
    "reviewer": { "runner": "codex", "provider": "openai", "model": "gpt-5.6-sol", "effort": "xhigh" },
    "coder":    { "runner": "codex", "provider": "greennode", "model": "z-ai/glm-5.3" }
  },
  "maxRounds": 3,
  "timeouts": { "splitter": 300, "reviewer": 300, "coder": 900 },
  "snapshotUntracked": false
}
JSON
  echo "Wrote $CONFIG_DIR/config.json — check the binary path before first run."
fi

# 2. Copy skill
mkdir -p "$SKILLS_DIR"
for d in "$REPO"/skills/*/; do
  cp -R "$d" "$SKILLS_DIR/"
done
echo "Installed skills into $SKILLS_DIR"

# 3. Đăng ký MCP — đường dẫn tuyệt đối vì app GUI không có PATH shell
codex mcp remove coding-glm 2>/dev/null || true
codex mcp add coding-glm \
  --env "GREENNODE_API_KEY=${GREENNODE_API_KEY:-}" \
  -- "$NODE_BIN" "$REPO/src/index.ts"

echo
echo "Done. Verify with:  codex mcp list"
echo "Set GREENNODE_API_KEY in ~/.codex/config.toml under the coding-glm server env if it is empty."
```

Chạy: `chmod +x scripts/install.sh`

- [ ] **Step 2: Viết docs/smoke-test.md**

```markdown
# Smoke test (tầng 3 — chạy tay)

Binary giả chứng minh logic điều phối đúng. Nó **không** chứng minh ta gọi `codex` đúng
cách. Chỉ bài này nói được điều đó. Chạy sau khi cài, và sau mỗi lần nâng cấp Codex.

## 1. Chuẩn bị

```bash
mkdir -p /tmp/mcg-smoke && cd /tmp/mcg-smoke
git init && git commit --allow-empty -m init
```

## 2. Kiểm config nạp được

```bash
node -e "import('./src/config.ts').then(m=>console.log(JSON.stringify(m.loadConfig(),null,1)))"
```

Kỳ vọng: in ra config, không ném lỗi.

## 3. Kiểm lá chắn git thật sự áp vào tiến trình con

```bash
npm test -- --test-name-pattern "rules chặn git"
```

Kỳ vọng: PASS, không `skip`. Nếu `skip` thì chưa có `~/.mcp-coding-glm/config.json`.

## 4. Chạy pipeline thật, một task bé

Trong Codex, ở thư mục `/tmp/mcg-smoke`:

```
$start-task
```

với plan: *"Tạo file sum.js xuất hàm sum(a,b) trả a+b, và sum.test.js kiểm nó bằng node:test."*

## 5. Những điều phải xác nhận

- [ ] `pipeline_start` trả `job_id` **ngay**, không treo
- [ ] `pipeline_status` cho thấy task chuyển `coding` → `reviewing` → `passed`
- [ ] File thật được tạo trong `/tmp/mcg-smoke`
- [ ] `git log` **không có commit mới** — lá chắn đã làm việc
- [ ] `~/.mcp-coding-glm/jobs/<job_id>/task-1/round-1.diff` có nội dung
- [ ] `~/.codex/rules/` **không** bị thêm file nào — lá chắn đúng phạm vi

## 6. Nếu bước 5 có mục nào hỏng

Rủi ro đã biết trong spec mục 13: nếu `CODEX_HOME` riêng không nạp `rules/`, chuyển sang
phương án dự phòng — chèn một `git` giả vào đầu `PATH` của tiến trình con, từ chối
`commit`/`push` và chuyển tiếp mọi lệnh khác tới git thật.
```

- [ ] **Step 3: Chạy toàn bộ test lần cuối**

Chạy: `npm test`
Kỳ vọng: PASS toàn bộ

- [ ] **Step 4: Commit**

```bash
git add scripts/install.sh docs/smoke-test.md
git commit -m "feat: install script and manual smoke test procedure"
```

---

## Ghi chú cho người thực thi

**Việc đầu tiên phải làm, trước Task 1:** chạy bước 3 và 5 của `docs/smoke-test.md` trên
một config tạm để xác minh `CODEX_HOME` riêng có nạp `rules/` không. Đây là rủi ro mở số 1
trong spec. Nếu nó hỏng, lá chắn git phải đổi sang phương án `git` giả **trước khi** viết
Task 3, chứ không phải sửa sau.

**Chệch khỏi spec, đã xác minh và cố ý:**

1. Spec ghi `@modelcontextprotocol/sdk`; package đúng là **`@modelcontextprotocol/server@2.3.1`**.
2. Spec không nói rõ; đã chốt: **vai coder bắt buộc runner `codex`**, vì lá chắn execpolicy
   không áp được cho runner `claude`.
3. Spec ghi "TypeScript"; đã chốt **không có bước build** — Node 22.18+ chạy `.ts` trực tiếp.
