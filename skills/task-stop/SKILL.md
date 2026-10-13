---
name: task-stop
description: Stop a running coding pipeline job. Use only when the user explicitly asks to stop.
---

# Task Stop

Call `pipeline_cancel` with the `job_id` from this conversation.

Then tell the user plainly: child processes were killed, and **files already modified were
left exactly as they are** — nothing was reverted, nothing was committed. Advise them to
check `git diff` before continuing.
