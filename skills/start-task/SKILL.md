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
4. Report the returned `job_id` and the task list.
5. Then call `pipeline_status` and relay progress. Keep polling until the state is
   `done`, `failed` or `cancelled`, then call `pipeline_result`.

Nothing is committed or pushed. When the job finishes, tell the user to review the diff
themselves, and name any task that ended as `needs_human`, `timeout` or `failed`.
