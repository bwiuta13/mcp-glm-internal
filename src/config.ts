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
