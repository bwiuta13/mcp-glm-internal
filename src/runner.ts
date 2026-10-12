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
