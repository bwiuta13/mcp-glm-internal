import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';
import { existsSync, statSync } from 'node:fs';
import { loadConfig, DEFAULT_CONFIG_PATH, type Config } from './config.ts';
import { createJob, getJob, cancelJob, readTail } from './jobs.ts';
import { runPipeline } from './pipeline.ts';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

/** Job đã khởi động trong tiến trình này — dùng để huỷ sạch khi server bị tắt. */
const started = new Set<string>();

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
    inputSchema: z.object({}).strict(),
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
    // .strict(): raw shape im lặng BỎ QUA khoá lạ, nên gõ nhầm `dry_run` thay vì
    // `dryRun` sẽ chạy thật và để model sửa file trong thư mục không có lưới an toàn.
    inputSchema: z.object({
      plan: z.string().min(1).describe('The agreed plan, as text'),
      cwd: z.string()
        .refine((p) => p.startsWith('/'), 'cwd must be an absolute path')
        .describe('Absolute path of the project directory to work in'),
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
    }).strict(),
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

    // Kiểm TRƯỚC khi tạo job: không có bước này thì đường dẫn sai vẫn sinh ra thư mục
    // job rồi mới hỏng, và báo lỗi "not a git work tree ... run git init" — lời khuyên
    // sai cho một đường dẫn không tồn tại.
    const st = statSync(cwd, { throwIfNoEntry: false });
    if (!st?.isDirectory()) return text(`cwd is not an existing directory: ${cwd}`);

    let job;
    try {
      job = createJob(plan, cwd);
    } catch (e) {
      return text((e as Error).message);
    }
    started.add(job.id);
    // Chạy nền; host poll bằng pipeline_status.
    void runPipeline(job, effective, { maxRounds, only, dryRun });
    // Trả job.cwd (đã chuẩn hoá), không trả chuỗi thô: người dùng phải thấy ĐÚNG thư mục
    // sắp bị sửa tại chỗ.
    return text(JSON.stringify({ job_id: job.id, state: job.state, cwd: job.cwd }));
  },
);

server.registerTool(
  'pipeline_status',
  {
    description: 'Poll the progress of a running pipeline job.',
    inputSchema: z.object({
      job_id: z.string().min(1),
      tail: z.number().int().positive().optional().describe('How many recent log lines to include'),
    }).strict(),
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
    inputSchema: z.object({ job_id: z.string().min(1) }).strict(),
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
    inputSchema: z.object({ job_id: z.string().min(1) }).strict(),
  },
  async ({ job_id }) => {
    const job = getJob(job_id);
    if (!job) return text(`No such job: ${job_id}`);
    // cancelJob trả false cho job đã kết thúc. Báo "No such job" ở đây là nói sai với
    // người dùng về việc có gì bị dừng hay không.
    if (!cancelJob(job_id)) {
      return text(`Job ${job_id} is already ${job.state}; nothing was cancelled.`);
    }
    return text(`Cancelled ${job_id}`);
  },
);

// Tiến trình con được spawn `detached`, nên tín hiệu theo nhóm KHÔNG tới chúng. Không
// huỷ ở đây thì giết server để lại coder `workspace-write` chạy tiếp, không timeout, không
// ai huỷ được — trong khi khoá thư mục đã được nhả cho job mới.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.once(sig, () => {
    for (const id of started) {
      try {
        cancelJob(id);
      } catch {
        // đang tắt máy, không còn chỗ nào để báo
      }
    }
    process.exit(0);
  });
}

await server.connect(new StdioServerTransport());
