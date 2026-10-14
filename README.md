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
- **No approvals, by construction**: children run headless with
  `approval_policy="never"` — there is no one to click "Approve", and with any other
  policy a child that wants to step outside its sandbox pauses and hangs until the
  role timeout kills it. Under `never` the same request is **denied immediately**
  instead of waiting; the sandbox itself still holds. (`--approve-for-me` cannot be
  used: it conflicts with `-s` on this CLI version.)
- **Coder network access**: the coder runs with
  `sandbox_workspace_write.network_access=true`, so `npm install` and test runs that
  need downloads work without lifting the sandbox. Read-only roles get no network.
- **Hard coder constraint**: the coder role must use the `codex` runner, because the
  execpolicy guard only applies there.
- **Group kill, with one gap**: child processes are spawned detached, and on timeout or
  cancel the whole process group is killed — so a grandchild *inside* that group dies with
  its parent. A grandchild that leaves the group (`setsid`, a daemonizing dev server or
  test watcher) is **not** killed: the pipeline only abandons its own end of the pipes and
  moves on, it does not wait for that process. A task that starts a detached background
  process can therefore leave it running after the job ends or is cancelled. It still runs
  under the coder's `workspace-write` sandbox, which allows writes to the working
  directory, so it can keep modifying your files. Check for stray processes after such a
  task.
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

## Recovering after a cancel or a bad run

The coder edits files in place and nothing is ever committed, so a job's log directory is
your only safety net: `~/.mcp-coding-glm/jobs/<job_id>/task-<n>-<id>/` (`<n>` is the task's
position, `<id>` the id the splitter gave it — usually `task-1-1` for the first task).

- `baseline.tree` — a git tree id: the whole working tree as it was before that task started.
- `round-N.diff` — that round's delta, written as soon as the coder returns.

**If a job is cancelled while the coder is running, that in-flight round's `round-N.diff` is
never written** — only `baseline.tree` exists. (Cancelled during the review step, the diff
for that round is already on disk.) You can still see what the task changed. From the
project directory:

```sh
git diff "$(cat ~/.mcp-coding-glm/jobs/<job_id>/task-1-1/baseline.tree)"
```

That shows edits to, and deletions of, existing files. It does **not** show files the task
newly created (`git diff` never lists untracked files); list those with
`git ls-files --others --exclude-standard`. For the exact delta including new files — what
the pipeline itself diffs — use a throwaway index, which leaves your real one untouched:

```sh
( export GIT_INDEX_FILE="$(mktemp -u)"
  git add -A
  git diff --binary "$(cat ~/.mcp-coding-glm/jobs/<job_id>/task-1-1/baseline.tree)" "$(git write-tree)"
  rm -f "$GIT_INDEX_FILE" )
```

The baseline tree is an **unreferenced** git object. An ordinary `git gc` keeps it for the
grace period (`gc.pruneExpire`, two weeks by default), but `git gc --prune=now` deletes it
immediately.

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

Prefer setting it up by hand? Copy [`config.example.json`](config.example.json) to
`~/.mcp-coding-glm/config.json` and edit it — see the Configuration notes below.

The one secret the server needs is the coder provider's API key, passed through the
environment — see [`env.example`](env.example) for the variable name and where it
belongs (`[mcp_servers.coding-glm]` → `env` in `~/.codex/config.toml`).

## Configuration

Single source of truth: `~/.mcp-coding-glm/config.json`. A ready-to-edit sample lives at
[`config.example.json`](config.example.json):

```sh
mkdir -p ~/.mcp-coding-glm
cp config.example.json ~/.mcp-coding-glm/config.json
# rồi sửa đường dẫn binaries cho máy bạn: command -v codex
```

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
    "splitter": { "runner": "codex", "provider": "openai", "model": "gpt-5.6-sol" },
    "reviewer": { "runner": "codex", "provider": "openai", "model": "gpt-5.6-sol" },
    "coder":    { "runner": "codex", "provider": "greennode", "model": "z-ai/glm-5.3" }
  },
  "maxRounds": 3,
  "timeouts": { "splitter": 300, "reviewer": 300, "coder": 900 },
  "snapshotUntracked": false
}
```

- Binary paths must be **absolute** and point to an existing, executable file.
- `roles.coder.runner` must stay `"codex"` (the git guard depends on it).
- `effort` applies to the `claude` runner only (it becomes `--effort`). On a `codex` role it
  is accepted but has no effect, which is why the sample above leaves it out.
- `timeouts` are in seconds, at most 86400.
- The file is validated strictly: an unknown key (say, a `maxRound` typo) is an error, not
  silently ignored.
- **The config is read once, when the server starts.** After editing `config.json`, restart
  Codex so it starts a fresh server.
- The server is started as `node src/index.ts` — no build, no watchers.

## MCP tools

| Tool | Purpose |
|---|---|
| `capabilities` | Report which runner/provider/model each role uses, and whether binaries exist |
| `pipeline_start` | Start a job from an agreed plan; returns a `job_id` immediately |
| `pipeline_status` | Poll job progress: state, current task, per-task state/round, log tail |
| `pipeline_result` | Fetch the full result of a finished job, including per-task reviews |
| `pipeline_cancel` | Kill a running job's process groups (see *Group kill* above for what can escape); modified files are left as they are |

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

## Known limitations

- **Install dependencies before a job if it needs them.** The coder now has network
  access (`sandbox_workspace_write.network_access=true`), so `npm install` works during
  a task, but pre-installed dependencies make rounds faster and cheaper.
- **Detached background processes can outlive a job** — see *Group kill, with one gap*.
- **Logs are never pruned.** `~/.mcp-coding-glm/jobs/` only grows, and a `round-N.diff` can
  be large. Clear old job directories yourself.
- **The `claude` runner is not verified end-to-end.** Its flags were checked against the real
  CLI, but no test drives a real `claude` run.

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

Working end-to-end with scripted binaries: 99/99 tests green. Real-model verification
(the smoke test) is the remaining manual step.
