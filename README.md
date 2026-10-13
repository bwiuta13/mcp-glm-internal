# mcp-coding-glm

A local [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that lets
**Codex act as a conductor** for a multi-model coding pipeline.

```
You chat with Codex  →  Codex researches + drafts a plan  →  you invoke $start-task
                                                                       ↓
        MCP server: SPLIT → (CODE → REVIEW → FIX)×N → done    (async job, poll status)
                        ↑                ↑
                       GLM           another model
```

The MCP server **never reasons and never edits files itself**. It schedules work, spawns
child CLIs, validates their JSON output, and keeps a log. All thinking happens inside the
already-authenticated `codex` / `claude` CLIs it drives.

## What it does

Given a plan agreed in the chat, the server:

1. **SPLIT** — asks the splitter model to break the plan into small, ordered tasks.
2. **CODE** — for each task, hands it to the coder model (e.g. GLM via GreenNode).
3. **REVIEW** — a separate reviewer model judges the resulting diff.
4. **FIX** — failed reviews loop back into CODE with the reviewer's guidance, up to
   `maxRounds` (default 3).
5. **STOP** — a task that still fails after all rounds is marked `needs_human`, and the
   pipeline **moves on to the next task instead of hanging**. Splitting is retried 3
   times on malformed JSON, then the job is marked `failed`.

Nothing is ever committed or pushed — the repo owner reviews the final diff and decides.

## Safety model

- **Git guard, two independent layers**: an execpolicy rules file blocks `git commit` /
  `git push` by argument pattern, and the `workspace-write` sandbox blocks any write to
  `.git` regardless of argument shape. The rules live in a dedicated `CODEX_HOME`, so
  the user's own Codex session is never touched.
- **Role-locked sandboxes**: splitter and reviewer always run `read-only`; the coder
  always runs `workspace-write`. `danger-full-access` is never used (it disables both
  guard layers at once).
- **Hard coder constraint**: the coder role must use the `codex` runner, because the
  execpolicy guard only applies there.
- **Group kill**: child processes are spawned detached and killed by process group, so
  a timed-out agent cannot leave orphaned grandchildren with file-write access.
- **Per-cwd lock**: only one job at a time per working directory — in-process and,
  additionally, cross-process via a lock file keyed on the normalized path.
- **Tree-snapshot baselines**: before each task the working tree is snapshotted into a
  git tree object (via a temporary `GIT_INDEX_FILE`, so the real index, status and refs
  are untouched), and each round's diff is taken between two tree ids. This is deliberate:
  a plain `git diff` returns **nothing** for a task that only creates new files, drops
  binary hunks, and breaks under common `git config` settings — and since this pipeline
  edits in place and never commits, those diffs are the only way to undo anything.
  Optionally (`snapshotUntracked: true`) untracked files are copied aside as well.
- **A git work tree is required**: a job in a non-git directory fails immediately, before
  any agent runs, because there would be no way to recover from it.

## Requirements

- **Node.js ≥ 22.18** (verified on 22.23.2). TypeScript files run directly through
  Node's native type stripping — **no build step, no `tsc`, no `tsx`**.
- The `codex` CLI installed and logged in (`claude` optional, for reviewer/splitter roles).
- A provider config for the coder model (e.g. GreenNode's OpenAI-compatible endpoint).

## Install

```sh
./scripts/install.sh
```

This writes a sample config to `~/.mcp-coding-glm/config.json`, copies the three Codex
skills into `~/.codex/skills/`, and registers the server with `codex mcp add` using
**absolute paths** (GUI apps don't inherit shell PATH).

## Configuration

Single source of truth: `~/.mcp-coding-glm/config.json`.

```json
{
  "binaries": { "codex": "/usr/local/bin/codex" },
  "providers": {
    "greennode": {
      "baseUrl": "https://tokenplan.api.greennode.ai/v1",
      "apiKeyEnv": "GREENNODE_API_KEY"
    }
  },
  "roles": {
    "splitter": { "runner": "codex", "provider": "openai", "model": "gpt-5.6-sol", "effort": "xhigh" },
    "reviewer": { "runner": "codex", "provider": "openai", "model": "gpt-5.6-sol", "effort": "xhigh" },
    "coder":    { "runner": "codex", "provider": "greennode", "model": "z-ai/glm-5.3" }
  },
  "maxRounds": 3,
  "timeouts": { "splitter": 300, "reviewer": 300, "coder": 900 },
  "snapshotUntracked": false
}
```

- Binary paths must be **absolute** and exist on disk.
- `roles.coder.runner` must stay `"codex"` (the git guard depends on it).
- The server is started as `node src/index.ts` — no build, no watchers.

## MCP tools

| Tool | Purpose |
|---|---|
| `capabilities` | Report which runner/provider/model each role uses, and whether binaries exist |
| `pipeline_start` | Start a job from an agreed plan; returns a `job_id` immediately |
| `pipeline_status` | Poll job progress: state, current task, per-task state/round, log tail |
| `pipeline_result` | Fetch the full result of a finished job, including per-task reviews |
| `pipeline_cancel` | Kill a running job's process tree; modified files are left as they are |

## Codex skills

Three skills gate manual control over the pipeline:

- `$start-task` — hand the agreed plan to the pipeline. Implicit invocation is
  **disabled**: the user must ask for it explicitly.
- `$task-status` — report progress. Implicit invocation allowed.
- `$task-stop` — cancel a running job. Implicit invocation is **disabled**.

## Development

```sh
npm install
npm test
```

Tests run with Node's built-in runner: `node --test "test/**/*.test.ts"`. The suite uses
scripted fake binaries (`test/fixtures/`) to exercise the pipeline end-to-end without
network access, plus a live guard test that runs real `codex execpolicy` checks when the
`codex` binary is available.

## Project layout

```
src/
├── index.ts      # MCP server wiring: 5 tools over stdio. No business logic.
├── config.ts     # Load + validate config, role sandboxes, absolute-binary checks.
├── contract.ts   # Extract JSON from prose, validate, build targeted repair prompts.
├── runner.ts     # Isolated CODEX_HOME guard, spawn codex/claude, timeouts, results.
├── pipeline.ts   # The SPLIT→CODE→REVIEW→FIX state machine. Prompt templates inline.
└── jobs.ts       # Job store: per-cwd locks (memory + cross-process), event log, cancel.
skills/           # Codex skill definitions ($start-task, $task-status, $task-stop)
scripts/          # install.sh — one-command setup
docs/             # design spec, implementation plan, smoke-test procedure
```

## Smoke test

After installing, follow [`docs/smoke-test.md`](docs/smoke-test.md) — a small, real,
one-task pipeline run that verifies the git guard actually applies to child processes,
that no commit is made, and that logs land in the right places.

## Status

Working end-to-end with scripted binaries: 70/70 tests green. Real-model verification
(the smoke test) is the remaining manual step.
