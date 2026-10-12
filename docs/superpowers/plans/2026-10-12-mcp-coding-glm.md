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
        id: z.coerce.string(),
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
        file: z.string().optional(),
        line: z.number().int().optional(),
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
  let text = raw.trim();

  // Đã quan sát thật: glm-5.2 trả JSON bọc trong hàng rào markdown.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    text = fence[1].trim();
  } else {
    const start = text.search(/[[{]/);
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      repairPrompt:
        `Your previous reply was not valid JSON (${(e as Error).message}). ` +
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
Kỳ vọng: PASS, 17 test (9 từ Task 1 + 8 mới)

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
import { ensureGuardHome } from '../src/runner.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.ts';

// Lấy đường dẫn codex từ config thật; bỏ qua test nếu máy chưa cấu hình.
function codexBin(): string | null {
  try { return loadConfig().binaries.codex; } catch { return null; }
}

test('rules chặn git commit và git push, cho qua lệnh vô hại', (t) => {
  const bin = codexBin();
  if (!bin) return t.skip('chưa có ~/.mcp-coding-glm/config.json');

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
# Giả lập `codex exec`: ghi FAKE_LAST_MESSAGE vào file sau -o, in JSONL ra stdout.
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
echo '{"type":"item.completed","item":{"type":"agent_message"}}'
if [ -n "$out" ]; then printf '%s' "${FAKE_LAST_MESSAGE:-{\"tasks\":[]}}" > "$out"; fi
if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi
exit "${FAKE_EXIT:-0}"
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
  assert.match(body, /"git","commit".*forbidden/s);
  assert.match(body, /"git","push".*forbidden/s);
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
  const r = await runRole('coder', cfg, {
    prompt: 'x', cwd: dir, guardHome: ensureGuardHome(dir), outFile: join(dir, 'o.txt'),
  });
  delete process.env.FAKE_SLEEP;
  assert.equal(r.timedOut, true);
});
```

- [ ] **Step 4: Chạy test để xác nhận nó hỏng**

Chạy: `npm test`
Kỳ vọng: FAIL với `Cannot find module '../src/runner.ts'`

- [ ] **Step 5: Viết src/runner.ts**

```ts
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROLE_SANDBOX, type Config, type Role } from './config.ts';

/** decision="forbidden" là loại agent không tự vượt qua được. */
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
    args.push('-p', '--model', rc.model, '--output-format', 'json', '--add-dir', opts.cwd);
    if (rc.effort) args.push('--effort', rc.effort);
    args.push('--tools', 'Read,Grep,Glob'); // runner claude chỉ dùng cho vai nghĩ
    args.push(opts.prompt);
  }

  return new Promise<RunResult>((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    opts.onSpawn?.(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });

    child.on('close', (code) => {
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

Chạy: `chmod +x test/fixtures/fake-codex.sh && npm test`
Kỳ vọng: PASS. Test lá chắn git sẽ `skip` nếu chưa có `~/.mcp-coding-glm/config.json` — điều này bình thường ở giai đoạn này.

- [ ] **Step 7: Commit**

```bash
git add src/runner.ts test/runner.test.ts test/guard.test.ts test/fixtures/fake-codex.sh
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
import { mkdtempSync, existsSync } from 'node:fs';
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
```

- [ ] **Step 2: Chạy test để xác nhận nó hỏng**

Chạy: `npm test`
Kỳ vọng: FAIL với `Cannot find module '../src/jobs.ts'`

- [ ] **Step 3: Viết src/jobs.ts**

```ts
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
  cwd: string;
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
  const holder = cwdLock.get(cwd);
  if (holder) {
    throw new Error(`A job is already running for ${cwd}: ${holder}. Cancel it first.`);
  }
  const id = randomUUID();
  const dir = join(root, 'jobs', id);
  mkdirSync(dir, { recursive: true });
  const job: Job = {
    id, cwd, plan, state: 'queued', tasks: [], current: null, error: null, dir,
    children: new Set(),
  };
  jobs.set(id, job);
  cwdLock.set(cwd, id);
  appendEvent(job, { type: 'job.created', cwd });
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function appendEvent(job: Job, event: Record<string, unknown>): void {
  appendFileSync(join(job.dir, 'events.jsonl'), JSON.stringify({ t: Date.now(), ...event }) + '\n');
}

export function readTail(job: Job, n: number): string[] {
  const p = join(job.dir, 'events.jsonl');
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-n);
}

export function releaseJob(job: Job): void {
  if (cwdLock.get(job.cwd) === job.id) cwdLock.delete(job.cwd);
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  for (const c of job.children) c.kill('SIGKILL');
  job.children.clear();
  job.state = 'cancelled';
  appendEvent(job, { type: 'job.cancelled' });
  releaseJob(job);
  return true;
}
```

- [ ] **Step 4: Chạy test để xác nhận đã xanh**

Chạy: `npm test`
Kỳ vọng: PASS, thêm 4 test

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
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createJob, releaseJob } from '../src/jobs.ts';
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
# Trả phản hồi thứ N từ FAKE_SCRIPT_DIR, tăng bộ đếm sau mỗi lần gọi.
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
d="$FAKE_SCRIPT_DIR"
n=$(cat "$d/counter" 2>/dev/null || echo 0)
body=$(cat "$d/$n.txt" 2>/dev/null || echo '')
echo $((n + 1)) > "$d/counter"
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
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
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

/** Lưới an toàn duy nhất: diff dạng văn bản. Thuần đọc, không đụng ref hay index. */
function captureDiff(cwd: string): string {
  try {
    return execFileSync('git', ['diff'], { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  } catch {
    return '';
  }
}

export async function runPipeline(
  job: Job,
  cfg: Config,
  opts: { dryRun?: boolean; only?: string[]; maxRounds?: number } = {},
): Promise<void> {
  const maxRounds = opts.maxRounds ?? cfg.maxRounds;
  const guardHome = ensureGuardHome();
  const out = (name: string) => join(job.dir, name);

  try {
    // ---------- SPLIT ----------
    job.state = 'splitting';
    let splitPrompt = SPLIT_PROMPT(job.plan);
    let tasks = null as null | ReturnType<typeof TaskListSchema.parse>;

    for (let attempt = 1; attempt <= 3; attempt++) {
      appendEvent(job, { type: 'split.attempt', attempt });
      const r = await runRole('splitter', cfg, {
        prompt: splitPrompt, cwd: job.cwd, guardHome, outFile: out(`split-${attempt}.txt`),
        onSpawn: (c) => job.children.add(c),
      });
      const parsed = parseContract(r.lastMessage, TaskListSchema);
      if (parsed.ok) { tasks = parsed.value; break; }
      appendEvent(job, { type: 'split.invalid', attempt, reason: parsed.repairPrompt });
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

    if (opts.dryRun) {
      job.state = 'done';
      appendEvent(job, { type: 'job.done', dryRun: true });
      return;
    }

    // ---------- CODE → REVIEW → FIX ----------
    job.state = 'running';
    for (const t of job.tasks) {
      job.current = t.item.id;
      const taskDir = join(job.dir, `task-${t.item.id}`);
      mkdirSync(taskDir, { recursive: true });

      // Mốc gốc để lùi về đầu task bằng `git apply -R`.
      writeFileSync(join(taskDir, 'baseline.diff'), captureDiff(job.cwd));

      // git diff không nhìn thấy file chưa từng được theo dõi; chép lại trước khi bị ghi đè.
      if (cfg.snapshotUntracked) {
        const snapDir = join(taskDir, 'untracked-before');
        mkdirSync(snapDir, { recursive: true });
        let untracked: string[] = [];
        try {
          untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
            cwd: job.cwd, encoding: 'utf8',
          }).split('\n').filter(Boolean);
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
          onSpawn: (c) => job.children.add(c),
        });
        writeFileSync(join(taskDir, `round-${round}.stdout`), coded.stdout);
        if (coded.timedOut) {
          t.state = 'timeout';
          appendEvent(job, { type: 'task.timeout', id: t.item.id, round });
          break;
        }

        const diff = captureDiff(job.cwd);
        writeFileSync(join(taskDir, `round-${round}.diff`), diff);

        t.state = 'reviewing';
        appendEvent(job, { type: 'task.reviewing', id: t.item.id, round });
        let reviewPrompt = REVIEW_PROMPT(t.item, diff);
        let review: Review | null = null;

        for (let attempt = 1; attempt <= 3; attempt++) {
          const r = await runRole('reviewer', cfg, {
            prompt: reviewPrompt, cwd: job.cwd, guardHome,
            outFile: join(taskDir, `round-${round}.review-${attempt}.msg`),
            onSpawn: (c) => job.children.add(c),
          });
          const parsed = parseContract(r.lastMessage, ReviewSchema);
          if (parsed.ok) { review = parsed.value; break; }
          reviewPrompt = `${REVIEW_PROMPT(t.item, diff)}\n\n${parsed.repairPrompt}`;
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

        guidance = review.guidance || review.issues.map((i) => `${i.severity}: ${i.message}`).join('\n');
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
