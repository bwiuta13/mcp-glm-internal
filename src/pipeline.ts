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
