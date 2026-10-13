import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
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

// `.strict()` ở MỌI cấp: đây là file người dùng tự gõ tay, nên "maxRound" thay vì "maxRounds"
// phải bị từ chối chứ không được nuốt im lặng rồi chạy với mặc định. Cùng lý do với
// `.strict()` trên schema của các tool MCP.
// `provider` có `.min(1)`: chuỗi rỗng là falsy nên lọt qua `rc.provider && ...` bên dưới và
// bỏ qua luôn bước kiểm provider đã khai báo.
const RoleCfg = z.object({
  runner: z.enum(['codex', 'claude']),
  provider: z.string().min(1).optional(),
  model: z.string().min(1),
  effort: z.string().optional(),
}).strict();

// `.max(86400)` ở timeouts: setTimeout của Node kẹp mọi hạn vượt 2^31-1 ms (~2.147.483 giây)
// xuống 1ms, nên một con số khổng lồ khiến MỌI lượt chạy hết giờ ngay lập tức. 86400 (một
// ngày) là trần hợp lý, nằm xa dưới ngưỡng đó.
const ConfigSchema = z.object({
  binaries: z.object({ codex: z.string(), claude: z.string().optional() }).strict(),
  providers: z
    .record(
      z.string(),
      z.object({
        baseUrl: z.string().min(1),
        apiKeyEnv: z.string().min(1),
        wireApi: z.literal('responses').default('responses'),
      }).strict(),
    )
    .default({}),
  roles: z.object({ splitter: RoleCfg, reviewer: RoleCfg, coder: RoleCfg }).strict(),
  maxRounds: z.number().int().positive().default(3),
  timeouts: z
    .object({
      splitter: z.number().int().positive().max(86400).default(300),
      reviewer: z.number().int().positive().max(86400).default(300),
      coder: z.number().int().positive().max(86400).default(900),
    })
    .strict()
    .default({ splitter: 300, reviewer: 300, coder: 900 }),
  snapshotUntracked: z.boolean().default(false),
}).strict();

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
    if (p === undefined) continue;
    if (!p.startsWith('/')) throw new Error(`binaries.${name} must be an absolute path, got: ${p}`);
    if (!existsSync(p)) throw new Error(`binaries.${name} not found on disk: ${p}`);
    // existsSync nhận cả thư mục, nên một đường dẫn trỏ nhầm vào thư mục từng được `capabilities`
    // in "OK" và lỗi thật chỉ lộ ra sau ba lượt "did not return valid JSON". Phải là FILE và có
    // quyền thực thi.
    if (!statSync(p).isFile()) throw new Error(`binaries.${name} is not a file: ${p}`);
    try {
      accessSync(p, constants.X_OK);
    } catch {
      throw new Error(`binaries.${name} is not executable: ${p}`);
    }
  }

  // Lá chắn git (execpolicy) chỉ áp được cho runner codex.
  if (cfg.roles.coder.runner !== 'codex') {
    throw new Error('roles.coder.runner must be "codex" — the git guard only applies to the codex runner');
  }

  for (const [role, rc] of Object.entries(cfg.roles)) {
    if (rc.runner === 'claude' && !cfg.binaries.claude) {
      throw new Error(`roles.${role}.runner is "claude" but binaries.claude is not configured`);
    }
    if (rc.provider && rc.provider !== 'openai' && !cfg.providers[rc.provider]) {
      throw new Error(`roles.${role}.provider "${rc.provider}" is not declared in providers`);
    }
  }

  return cfg;
}
