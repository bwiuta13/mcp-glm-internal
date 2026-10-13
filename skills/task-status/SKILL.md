---
name: task-status
description: Report the progress of a running coding pipeline job.
---

# Task Status

Call `pipeline_status` with the `job_id` from this conversation and `tail: 30`.

Report, in this order: the job state, which task is running now, each task with its state
and round number, and anything notable from the log tail.

If the state is `done`, `failed` or `cancelled`, call `pipeline_result` instead and
summarise the outcome per task.
