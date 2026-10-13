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
  for (const c of job.children) {
    // Giết theo NHÓM, giống hệt đường timeout trong runner.ts. `c.kill()` chỉ tới con
    // trực tiếp: cháu vẫn sống, vẫn giữ pipe, và một coder có quyền ghi file sẽ chạy
    // tiếp như mồ côi. Đo thật trên đường timeout: 6232ms so với 505ms.
    // `onSpawn` bắn cả khi spawn hỏng, nên pid có thể undefined.
    try {
      if (c.pid) process.kill(-c.pid, 'SIGKILL');
      else c.kill('SIGKILL');
    } catch {
      c.kill('SIGKILL');
    }
  }
  job.children.clear();
  job.state = 'cancelled';
  appendEvent(job, { type: 'job.cancelled' });
  releaseJob(job);
  return true;
}
