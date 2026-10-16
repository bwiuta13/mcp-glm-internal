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
If the DONE WHEN criterion is ALREADY satisfied by code that exists in the repository right now
(common when earlier work is sitting uncommitted), do NOT modify anything just to produce a diff:
reply "already satisfied" and cite the file and line that satisfy it.
You must NOT run "git commit" or "git push" — they are blocked and will fail.
Reply with a short summary of what you changed.`;

const REVIEW_PROMPT = (t: { title: string; acceptance: string }, diff: string) =>
  `You are reviewing one task of a coding pipeline.

TASK: ${t.title}
DONE WHEN: ${t.acceptance}

DIFF:
${diff || '(no changes were made)'}

You have READ access to this repository: open the task's files and check the criterion against
the CURRENT code, not only against the diff.
If the diff says no changes were made, that does NOT decide the verdict: the work may already
exist in the repository from before this round (the coder is told to skip no-op edits). If the
DONE WHEN criterion is already satisfied in the current code, return pass. Only if it is not
satisfied, return fail with guidance telling the coder exactly what to change.
Judge only whether the task is satisfied. Return this exact shape:
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
 *
 * Mọi execFileSync trong file này chạy TRÊN event loop và có `timeout: 60_000`. Không có hạn
 * thì `git add -A` trên repo lớn (hay một git bị kẹt) làm server không trả lời nổi
 * `pipeline_status` lẫn `pipeline_cancel` — trông như treo đúng lúc người dùng đưa tay tìm nút
 * dừng. Hết hạn thì execFileSync ném, và nhánh catch bên dưới trả null.
 */
function snapshotTree(cwd: string): string | null {
  const idx = join(tmpdir(), `mcg-idx-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    execFileSync('git', ['add', '-A'], {
      cwd, env, stdio: ['ignore', 'ignore', 'ignore'], timeout: 60_000,
    });
    return execFileSync('git', ['write-tree'], {
      cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000,
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
    // Gốc dữ liệu suy ra từ job.dir (= <gốc>/jobs/<id>, xem createJob) thay vì mặc định ở
    // $HOME: job của test nằm trong cây tạm của nó thì guard home cũng phải ở đó, nếu không
    // mỗi lần chạy test lại ghi vào ~/.mcp-coding-glm thật. Ở production gốc vẫn là
    // ~/.mcp-coding-glm nên đường dẫn không đổi.
    const guardHome = ensureGuardHome(dirname(dirname(job.dir)));

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
    // Plan đi thẳng vào argv của splitter. Vượt ~1MiB (giới hạn macOS) thì spawn ném E2BIG:
    // exitCode -1, tin nhắn rỗng, ba lượt phí, rồi người dùng bị báo "did not return valid JSON"
    // — sai nguyên nhân. Cắt như đã làm với diff của reviewer, nhưng có ghi sự kiện: mất đuôi
    // plan là mất việc, người dùng phải biết được.
    const PLAN_CAP = 200_000;
    let plan = job.plan;
    if (plan.length > PLAN_CAP) {
      plan = `${plan.slice(0, PLAN_CAP)}\n\n[... plan truncated: ` +
        `${job.plan.length - PLAN_CAP} more characters were omitted because it exceeded the size limit ...]`;
      appendEvent(job, { type: 'plan.truncated', original: job.plan.length, kept: PLAN_CAP });
    }
    let splitPrompt = SPLIT_PROMPT(plan);
    let tasks = null as null | ReturnType<typeof TaskListSchema.parse>;
    let splitTimedOut = false;

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
      // Hết giờ thì dừng luôn, như coder: thử lại chỉ đốt thêm một hạn nữa (3 × timeouts.splitter)
      // rồi báo "did not return valid JSON" — chẩn đoán sai, vì vấn đề là agent không trả lời.
      if (r.timedOut) {
        splitTimedOut = true;
        writeFileSync(join(job.dir, `split-${attempt}.stderr`), r.stderr);
        appendEvent(job, { type: 'split.timeout', attempt, seconds: cfg.timeouts.splitter });
        break;
      }
      const parsed = parseContract(r.lastMessage, TaskListSchema);
      if (parsed.ok) { tasks = parsed.value; break; }
      writeFileSync(join(job.dir, `split-${attempt}.stderr`), r.stderr);
      appendEvent(job, {
        type: 'split.invalid', attempt, code: r.exitCode, reason: parsed.repairPrompt,
      });
      splitPrompt = `${SPLIT_PROMPT(plan)}\n\n${parsed.repairPrompt}`;
    }

    if (!tasks) {
      job.state = 'failed';
      job.error = splitTimedOut
        ? `split failed: splitter timed out after ${cfg.timeouts.splitter}s`
        : 'split failed: splitter did not return valid JSON after 3 attempts';
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
            cwd: job.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000,
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
        if (!treeBefore || !treeAfter) {
          // Không chụp được thì diff rỗng KHÔNG có nghĩa là coder không làm gì, nhưng round-N.diff
          // vẫn ra rỗng và reviewer vẫn bị bảo "(no changes were made)" — nên task có thể đậu trên
          // đúng cơ sở đó. Ít nhất phải để lại dấu vết để người đọc log phân biệt được.
          appendEvent(job, {
            type: 'snapshot.failed', id: t.item.id, round,
            before: treeBefore !== null, after: treeAfter !== null,
          });
        } else {
          try {
            // So hai tree -> delta ĐÚNG CỦA TASK NÀY, không lẫn việc của task trước và
            // không lẫn thay đổi người dùng đã có sẵn. --binary để bản vá dùng lại được.
            diff = execFileSync('git', [
              '-c', 'core.quotePath=false', 'diff', '--binary', '--no-color', '--no-ext-diff',
              treeBefore, treeAfter,
            ], {
              cwd: job.cwd, encoding: 'utf8',
              maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000,
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
          appendEvent(job, { type: 'task.timeout', id: t.item.id, round, role: 'coder' });
          break;
        }

        // Diff rỗng sau khi coder HOÀN TẤT (không timeout, không snapshot hỏng) thì ghi dấu:
        // thường là criterion đã được thỏa mãn từ trước nên coder bỏ qua việc sửa (đã đo ở
        // account/idp: partial work có sẵn → reviewer bị nói dối "no changes" → đốt hết vòng).
        // Sự kiện này cho người đọc log phân biệt "coder không làm gì" với "việc đã có sẵn".
        if (!diff && treeBefore && treeAfter) {
          appendEvent(job, { type: 'task.no_diff', id: t.item.id, round });
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
        let reviewTimedOut = false;

        for (let attempt = 1; attempt <= 3; attempt++) {
          const r = await runRole('reviewer', cfg, {
            prompt: reviewPrompt, cwd: job.cwd, guardHome,
            outFile: join(taskDir, `round-${round}.review-${attempt}.msg`),
            onSpawn: (c) => { job.children.add(c); c.on('close', () => job.children.delete(c)); },
          });
          if (job.state === 'cancelled') return;
          // Reviewer treo thì thử lại chỉ đốt thêm hạn (3 × timeouts.reviewer mỗi vòng) rồi báo
          // review_unparseable — chẩn đoán sai. Dừng ngay và gọi đúng tên là timeout.
          if (r.timedOut) { reviewTimedOut = true; break; }
          const parsed = parseContract(r.lastMessage, ReviewSchema);
          if (parsed.ok) { review = parsed.value; break; }
          appendEvent(job, { type: 'review.invalid', id: t.item.id, round, attempt });
          reviewPrompt = `${REVIEW_PROMPT(t.item, shown)}\n\n${parsed.repairPrompt}`;
        }

        if (reviewTimedOut) {
          t.state = 'timeout';
          appendEvent(job, { type: 'task.timeout', id: t.item.id, round, role: 'reviewer' });
          break;
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
    // Huỷ giữa chừng: cancelJob đã giết con và đổi job sang 'cancelled', nhưng task đang dở vẫn
    // mang 'coding'/'reviewing' và job.current vẫn trỏ vào nó. `$task-stop` nói agent đã bị
    // giết, rồi `$task-status` lại báo một task đang code. Dọn ở đây vì MỌI đường thoát do huỷ
    // (ba điểm `return` sau await lẫn nhánh catch) đều đi qua finally.
    if (job.state === 'cancelled') {
      job.current = null;
      for (const task of job.tasks) {
        if (task.state === 'coding' || task.state === 'reviewing') task.state = 'pending';
      }
    }
    releaseJob(job);
  }
}
