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
