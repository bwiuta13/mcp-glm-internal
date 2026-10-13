---
name: task-stop
description: Stop a running coding pipeline job. Use only when the user explicitly asks to stop.
---

# Task Stop

Call `pipeline_cancel` with the `job_id` from this conversation.

Relay the tool's reply literally — do not assume anything was stopped:

- If it says **"Cancelled"**, tell the user the running agents were killed, and that
  **files already modified were left exactly as they are** — nothing was reverted,
  nothing was committed. Advise them to check `git diff` before continuing.
- If it says the job is **already done / failed / cancelled**, say exactly that: nothing
  was running, so nothing was stopped.
- If it says **"No such job"**, say the id is unknown to this server. Jobs live only in
  the server process that started them, so a job started from a different Codex session
  cannot be cancelled from here.
