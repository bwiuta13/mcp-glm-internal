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
