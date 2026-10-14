import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
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

  // File này DÙNG CHUNG cho mọi job. `writeFileSync` cắt cụt về 0 byte rồi mới ghi, nên hai job
  // ở hai thư mục khác nhau có thể để một codex con đọc đúng khoảnh khắc file rỗng — và lớp
  // lá chắn execpolicy biến mất mà không báo gì. Ghi ra tệp tạm rồi `rename` đè lên: người đọc
  // luôn thấy hoặc bản cũ hoặc bản mới, đầy đủ. Tệp tạm nằm NGOÀI `rules/` để codex, khi quét
  // thư mục đó, không bao giờ gặp một file ghi dở.
  const rules = join(home, 'rules', 'guard.rules');
  const tmp = join(home, `.guard.rules.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, GUARD_RULES);
    renameSync(tmp, rules);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }

  // CODEX_HOME riêng cũng tách luôn phần xác thực: `codex exec --help` ghi rõ "auth still
  // uses CODEX_HOME". Đo thật với guard home sạch: 401 Unauthorized. Nối auth của người
  // dùng vào đây, nếu họ có. Không có thì provider `openai` sẽ hỏng và install.sh chọn
  // preset khác — xem scripts/install.sh.
  const realAuth = join(homedir(), '.codex', 'auth.json');
  const linked = join(home, 'auth.json');
  try {
    if (existsSync(realAuth) && !existsSync(linked)) symlinkSync(realAuth, linked);
  } catch {
    // không nối được thì thôi; nhánh GreenNode dùng env key nên không cần auth.json
  }
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

/**
 * Con chạy headless: không có ai bấm "Approve". Với approval_policy mặc định,
 * codex con dừng lại chờ phê duyệt và treo đến hết timeout. `approval_policy="never"`
 * bảo nó cứ chạy trong sandbox, việc cần vượt sandbox sẽ bị TỪ CHỐI thay vì treo —
 * `-c` ghi đè config, ghép được với `-s` (khác `--approve-for-me` vốn xung đột flag).
 *
 * Coder còn cần mạng (npm install, chạy test): `network_access=true` chỉ hợp lệ
 * khi sandbox_mode là workspace-write, nên chỉ bật cho vai có sandbox đó.
 */
const APPROVAL_NEVER = ['-c', 'approval_policy="never"'];

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
      ...APPROVAL_NEVER,
      ...(ROLE_SANDBOX[role] === 'workspace-write'
        ? ['-c', 'sandbox_workspace_write.network_access=true']
        : []),
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
