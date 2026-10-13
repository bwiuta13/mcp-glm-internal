---
name: start-task
description: Hand an agreed plan to the coding pipeline and start it. Use only when the user explicitly asks to start the task.
---

# Start Task

The user has finished planning and wants the pipeline to begin.

1. Call `capabilities` first. Tell the user in one line which runner and model each role
   is using, so they know what they are about to drive.
2. Collect the plan that was agreed in this conversation into a single block of text.
   Include every decision made during the discussion — the pipeline cannot see this chat.
3. Call `pipeline_start` with that plan and the absolute path of the project directory.
   Pass `maxRounds`, `only` or `dryRun` only if the user named them in their invocation.
4. Report the returned `job_id` and **the resolved `cwd` from the reply** — that is the
   directory about to be edited in place, and it may differ from what the user typed.
   The reply carries no task list; the split happens after the job starts.
5. Then call `pipeline_status` to show the task list once splitting finishes.
   After that, poll at a **human pace — roughly every 30 to 60 seconds**, not in a tight
   loop, and report only when something changes. If the user would rather not wait, hand
   control back and tell them to type `$task-status` whenever they want an update.
   When the state reaches `done`, `failed` or `cancelled`, call `pipeline_result`.

If `capabilities` reports the config is unusable, **stop here** and show the user the
reason instead of starting a job.

Nothing is committed or pushed. When the job finishes, tell the user to review the diff
themselves, and name any task that ended as `needs_human`, `timeout` or `failed`.
