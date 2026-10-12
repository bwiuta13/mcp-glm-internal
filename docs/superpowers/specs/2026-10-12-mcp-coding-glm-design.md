# mcp-coding-glm — Thiết kế

Ngày: 2026-10-12
Trạng thái: đã duyệt thiết kế, chưa lập kế hoạch triển khai

## 1. Mục tiêu

Một MCP server chạy local, cho phép **Codex làm nhạc trưởng** điều phối một pipeline
coding nhiều model: Codex nghiên cứu và lập plan, một model chia plan thành task nhỏ
và review code, một model khác viết code và chạy test.

Yêu cầu gốc của người dùng:

- Codex: research + plan
- Claude (Sonnet, effort cao): chia nhỏ task + giám sát, review code của GLM
- GLM: nhận task nhỏ, viết code
- Nếu môi trường không cấu hình Claude: Codex đảm nhiệm chia task + review,
  GLM tự code và test

## 2. Bối cảnh đã xác minh trên máy đích

Mọi dòng dưới đây đều đã kiểm chứng trực tiếp, không suy đoán.

| # | Sự thật | Cách xác minh |
|---|---|---|
| 1 | `codex` 0.159.2 tại `~/.nvm/versions/node/v22.23.2/bin/codex` | `command -v`, `--version` |
| 2 | `claude` 2.1.227 tại `~/.local/bin/claude` | `command -v`, `--version` |
| 3 | Codex Desktop là `/Applications/ChatGPT.app`, dùng chung `~/.codex/config.toml` với CLI | `codex mcp list` liệt kê cả MCP của app |
| 4 | MCP do app GUI khởi chạy không kế thừa env shell; các entry sẵn có đều tiêm `env` tường minh và dùng đường dẫn tuyệt đối | đọc `codex mcp list` |
| 5 | `wire_api = "chat"` đã bị gỡ; chỉ còn `"responses"` | chạy thật → `Error loading config.toml` |
| 6 | Gateway GreenNode `https://tokenplan.api.greennode.ai/v1` trả HTTP 200 cho **cả ba**: `/responses`, `/chat/completions`, `/messages` | probe HTTP |
| 7 | Model khả dụng trên gateway: `z-ai/glm-5.2`, `z-ai/glm-5.3`, `z-ai/glm-5.3-flash-thirdparty` | `GET /models` |
| 8 | Gateway **nhận** `json_schema` nhưng **không tuân thủ**: `glm-5.2` trả JSON bọc ```` ``` ````, thiếu field `required`; `glm-5.3` trả rỗng | probe có schema vs không schema |
| 9 | Bỏ schema, prompt thuần → `glm-5.3` trả JSON đúng kiểu, đủ field | probe |
| 10 | `codex execpolicy check --rules <f> -- <cmd>` hoạt động; `decision="forbidden"` là loại agent không vượt được | chạy thật |
| 11 | Rules nạp từ `$CODEX_HOME/rules/`; mặc định `~/.codex/rules/default.rules` | tìm thấy file |
| 12 | Skill Codex hỗ trợ `policy.allow_implicit_invocation: false` | đọc `~/.codex/skills/*/agents/openai.yaml` |
| 13 | Cú pháp gọi skill tường minh trong Codex là `$<tên>` | `default_prompt` của skill bundled |

| 14 | Node 22.23.2 chạy `.ts` trực tiếp bằng type-stripping gốc — **không cần bước build** | chạy thật một file `.ts` có type/interface |
| 15 | Package MCP đúng là `@modelcontextprotocol/server@2.3.1` (không phải `@modelcontextprotocol/sdk`); `inputSchema` nhận **raw shape** chứ không phải `z.object()` | dựng server stdio thật, đẩy JSON-RPC vào stdin |
| 16 | `node --test` **không nhận đối số là thư mục**; phải dùng glob | chạy thật, so sánh hai dạng |

Rủi ro ngoại vi đã biết: [openai/codex#25312](https://github.com/openai/codex/issues/25312) —
rules bị bỏ qua dưới `danger-full-access`.

## 3. Kiến trúc

```
Codex Desktop / CLI  (gpt-5.6-sol, xhigh)
  vai PLANNER: research + plan, ngay trong phiên chat
          │
          │  MCP stdio — đăng ký một lần trong ~/.codex/config.toml
          ▼
mcp-coding-glm   (TypeScript, Node 22)
  · job store (bất đồng bộ + poll)
  · máy trạng thái  SPLIT → CODE → REVIEW → FIX
  · runner registry (đọc từ config file)
  · validate + vòng sửa JSON
  · log thô theo từng job
          │
          ├── spawn ──> runner "codex"   (mặc định mọi vai)
          └── spawn ──> runner "claude"  (chỉ khi config khai)
```

**Nguyên tắc xuyên suốt:** MCP không tự suy luận và không tự sửa file. Nó xếp lịch,
gọi tiến trình con, kiểm JSON, ghi log. Mọi suy luận nằm trong harness đã được kiểm
chứng thực chiến. Điều này giữ MCP đủ nhỏ để đọc hết trong một lượt.

### 3.1 Vì sao không gọi API trực tiếp

Hai phương án đã cân nhắc và loại:

- **Tự viết agent loop gọi thẳng `/v1/responses`**: phải tự xây và tự bảo trì cả một
  coding agent (apply patch, sandbox, chạy test) — đúng phần khó nhất mà Codex và
  Claude Code đã giải xong.
- **Lai: CLI cho coder, API trực tiếp cho splitter/reviewer**: vướng rào chặn auth —
  Claude của người dùng là subscription Claude Code (OAuth), không phải API key. Gọi
  raw API sẽ cần `ANTHROPIC_API_KEY` riêng, phát sinh chi phí mới trong khi
  subscription đang nằm không.

Lý do quyết định chọn hướng spawn CLI **không phải** vì nó sạch hơn, mà vì nó dùng
được hai thứ người dùng đã trả tiền và đã đăng nhập: Claude Code subscription và
GreenNode token plan.

## 4. Vai trò và runner

Vai trò là cố định; ai đóng vai là cấu hình.

| Vai trò | Nhiệm vụ | Sandbox | Đổi runner được |
|---|---|---|---|
| PLANNER | research + plan | — (chạy trong phiên chat Codex) | không |
| SPLITTER | plan → danh sách task JSON | read-only | có |
| REVIEWER | task + diff → verdict JSON | read-only | có |
| CODER | viết code + chạy test | workspace-write | có |

**Sandbox do vai trò quyết định, không do config.** Khoá cứng trong code: CODER luôn
`workspace-write`, SPLITTER/REVIEWER luôn `read-only`. Lý do: `danger-full-access` vô
hiệu hoá lá chắn git (sự thật #10 + issue #25312), nên không được để config mở đường
tới đó.

**Vai CODER bắt buộc `runner: "codex"`.** Phát hiện khi lập kế hoạch: lá chắn git dựa
trên execpolicy của Codex, mà runner `claude` không có cơ chế tương đương. Cho phép
`coder: claude` là lặng lẽ gỡ mất lá chắn. Config validator phải từ chối.

### 4.1 Ba preset chạy được ngay

```
preset 1 — còn Claude
  splitter/reviewer : claude · sonnet · effort xhigh
  coder             : codex  · greennode · z-ai/glm-5.3

preset 2 — bỏ Claude, dùng ChatGPT sub  [khuyến nghị khi bỏ Claude]
  splitter/reviewer : codex  · openai    · gpt-5.6-sol
  coder             : codex  · greennode · z-ai/glm-5.3

preset 3 — thuần GreenNode
  splitter/reviewer : codex  · greennode · z-ai/glm-5.3
  coder             : codex  · greennode · z-ai/glm-5.2
```

Cả ba là **cùng một đường code**, chỉ khác tham số dòng lệnh. Phụ thuộc cứng duy nhất
của hệ thống là binary `codex`.

**Ghi chú về chất lượng review:** giá trị của việc một model review model khác nằm ở
chỗ **chúng là model khác nhau** — mù ở chỗ khác nhau nên bắt được lỗi khác nhau.
Preset 1 và 2 giữ được tính chất này. Preset 3 gần như GLM tự chấm bài GLM nên dùng
hai model khác nhau (`glm-5.3` review `glm-5.2`) để giữ chút khác biệt, nhưng vẫn là
preset yếu nhất về mặt review.

### 4.2 Hình dạng lệnh

Runner `codex`:

```
<codex_abs> exec
  --skip-git-repo-check
  -C <cwd>
  -s <read-only | workspace-write>     # do vai trò quyết định
  --json
  -o <outfile>
  -m <model>
  -c model_provider="<provider_id>"
  -c model_providers.<id>.name="<id>"
  -c model_providers.<id>.base_url="<baseUrl>"
  -c model_providers.<id>.env_key="<apiKeyEnv>"
  -c model_providers.<id>.wire_api="responses"
  "<prompt>"
```

env tiêm vào tiến trình con: `CODEX_HOME=<guardHome>`, `<apiKeyEnv>=<key>`,
`PATH=<danh sách tuyệt đối tối thiểu>`.

Với provider mặc định `openai` (preset 2) thì bỏ hết các `-c model_providers.*`, chỉ
giữ `-m gpt-5.6-sol`, và `<guardHome>` cần symlink `auth.json` từ `~/.codex/`.

Runner `claude`:

```
<claude_abs> -p
  --model <model>
  --effort <effort>
  --output-format json
  --add-dir <cwd>
  --tools "Read,Grep,Glob"     # vai trò nghĩ: chỉ đọc
  --append-system-prompt <hợp đồng JSON>
  "<prompt>"
```

## 5. Bề mặt MCP tool

Năm tool, cố ý giữ ít.

| Tool | Vào | Ra |
|---|---|---|
| `pipeline_start` | `plan`, `cwd`, `options?` | `{ job_id }` — trả về ngay |
| `pipeline_status` | `job_id`, `tail?` | `{ state, tasks[], current, log_tail }` |
| `pipeline_result` | `job_id` | tổng kết + diff + ghi chú review từng task |
| `pipeline_cancel` | `job_id` | giết tiến trình con, giữ nguyên file đã sửa |
| `capabilities` | — | runner/provider đang khai, binary tìm thấy, vai nào ai đóng |

`capabilities` không phải trang trí: nó để Codex biết mình đang điều khiển ai **trước
khi** bắt đầu, và để người dùng thấy ngay mình đang ở preset nào thay vì đoán.

**Cố ý không làm:** không tool research (Codex làm rồi); không tool commit/push
(người dùng cấm); không chạy song song nhiều task (sửa tại chỗ cùng thư mục mà chạy
song song là tự chuốc xung đột).

### 5.1 Tham số `options` của `pipeline_start`

Tất cả đều tuỳ chọn; thiếu thì lấy từ config file. Đây là đường để ghi đè cho một việc
lẻ mà không phải sửa config.

| Trường | Kiểu | Ý nghĩa |
|---|---|---|
| `maxRounds` | số | ghi đè số vòng code→review tối đa cho job này |
| `roles` | object | ghi đè một phần map vai trò, ví dụ `{"coder":{"model":"z-ai/glm-5.2"}}` |
| `only` | mảng id task | chỉ chạy những task này sau khi chia (để chạy lại phần hỏng) |
| `dryRun` | bool | chỉ chạy SPLIT rồi dừng, trả danh sách task mà không sửa file |

`dryRun` tồn tại vì một lý do cụ thể: xem plan được chia thành gì **trước khi** cho
model động vào thư mục không có lưới an toàn (mục 10.1).

### 5.2 Chặn gọi tự phát

Mô tả của `pipeline_start` phải ghi rõ: *chỉ gọi khi người dùng đã gõ `$start-task`*.
Đây là lớp chặn **bắt buộc**, không phải tuỳ chọn — `allow_implicit_invocation: false`
chỉ cấm Codex tự kích hoạt **skill**, nó không ngăn Codex gọi thẳng tool. Mô tả tool
là chỗ duy nhất chặn được đường đó.

## 6. Máy trạng thái

Trạng thái job: `queued` → `splitting` → `running` → `done` | `failed` | `cancelled`

Trạng thái task: `pending` → `coding` → `reviewing` → `passed`
Kết thúc khác: `needs_human` (hết maxRounds), `timeout`, `failed`

Luồng một lần chạy:

1. Người dùng chat với Codex; Codex research + viết plan ngay trong phiên
2. Người dùng gõ `$start-task` → Codex gọi `pipeline_start({ plan, cwd })` → `job_id` ngay
3. **SPLIT** — runner vai `splitter` nhận plan → danh sách task JSON (validate + sửa, tối đa 3 lần)
4. **Với mỗi task, tuần tự:**
   a. **CODE** — runner `coder`, `-s workspace-write`, `CODEX_HOME` riêng có rules chặn git
   b. thu diff bằng `git diff` (không phải repo git thì so snapshot file)
   c. **REVIEW** — runner `reviewer` nhận *task + diff* → verdict JSON
   d. `fail` → vòng sau đưa `guidance` cho coder; hết `maxRounds` → `needs_human`,
      **đi tiếp task khác**, không treo pipeline
5. `state: done` → Codex gọi `pipeline_result`
6. **Không commit, không push.** Người dùng xem diff rồi tự quyết.

### 6.1 Hợp đồng JSON

Không dùng structured output phía provider (sự thật #8). Prompt xin JSON, tự validate,
sai thì gửi lại **kèm lỗi cụ thể** — không phải "sai rồi, làm lại".

SPLITTER trả về:

```json
{ "tasks": [ {
    "id": "1",
    "title": "ngắn gọn, một dòng",
    "detail": "mô tả đủ để coder làm mà không cần đọc lại plan",
    "files": ["đường dẫn dự kiến chạm tới"],
    "acceptance": "làm sao biết là xong"
} ] }
```

REVIEWER trả về:

```json
{ "verdict": "pass" | "fail",
  "issues": [ { "severity": "blocker|major|minor",
                "file": "...", "line": 123, "message": "..." } ],
  "guidance": "coder phải sửa gì ở vòng sau" }
```

## 7. Cấu hình

`~/.mcp-coding-glm/config.json`

```jsonc
{
  "binaries": {
    "codex":  "/Users/lap14568/.nvm/versions/node/v22.23.2/bin/codex",
    "claude": "/Users/lap14568/.local/bin/claude"
  },
  "providers": {
    "greennode": {
      "baseUrl":   "https://tokenplan.api.greennode.ai/v1",
      "apiKeyEnv": "GREENNODE_API_KEY",
      "wireApi":   "responses"
    }
  },
  "roles": {
    "splitter": { "runner": "codex", "provider": "openai",    "model": "gpt-5.6-sol", "effort": "xhigh" },
    "reviewer": { "runner": "codex", "provider": "openai",    "model": "gpt-5.6-sol", "effort": "xhigh" },
    "coder":    { "runner": "codex", "provider": "greennode", "model": "z-ai/glm-5.3" }
  },
  "maxRounds": 3,
  "timeouts":  { "splitter": 300, "reviewer": 300, "coder": 900 },
  "snapshotUntracked": false
}
```

Mặc định xuất xưởng là **preset 2**: `coder = z-ai/glm-5.3` đúng như yêu cầu gốc
("GLM 5.3 để coding"), còn vai nghĩ dùng `gpt-5.6-sol` nên giữ được tính đa dạng model
khi review mà không cần Claude.

`openai` là provider dựng sẵn của Codex, **không cần khai** trong `providers`. Nhưng nó
cần auth — xem rủi ro mở 13.2 (symlink `auth.json`).

Muốn dùng Claude thì sửa đúng hai dòng, không đụng code:

```jsonc
"splitter": { "runner": "claude", "model": "sonnet", "effort": "xhigh" },
"reviewer": { "runner": "claude", "model": "sonnet", "effort": "xhigh" },
```

**Config là nguồn chân lý duy nhất.** Không tự dò, không tự đổi model sau lưng người
dùng. Khai `claude` thì dùng `claude`; không khai thì `codex` đóng vai đó.

Trường `binaries` tồn tại vì sự thật #4 (app GUI không có PATH shell). Nó cũng chính
là khe mà test tầng 1 dùng tới — xem mục 12.

## 8. Skills — cửa chặn thủ công

Đặt trong `~/.codex/skills/`.

| Skill | Dùng khi | Implicit |
|---|---|---|
| `$start-task` | chốt plan, bắt đầu chạy → trả `job_id` | **cấm** |
| `$task-status` | "tới đâu rồi?" → tiến độ + đuôi log | cho phép |
| `$task-stop` | dừng giữa chừng, giữ nguyên file đã sửa | **cấm** |

Cấu trúc mỗi skill:

```
~/.codex/skills/start-task/
├── SKILL.md              # frontmatter: name, description
└── agents/openai.yaml    # policy.allow_implicit_invocation: false
```

`$start-task` nhận tham số tuỳ chọn để không phải sửa config cho việc lẻ:

```
$start-task
$start-task maxRounds=5
$start-task coder=z-ai/glm-5.3 reviewer=gpt-5.6-sol
```

## 9. Lá chắn git

Ràng buộc cứng của người dùng: **GLM không được tự commit hay push.** Nhắc trong prompt
rồi hy vọng là không đủ — model quên là mất branch.

Cách làm: spawn `codex` với `CODEX_HOME` riêng (`~/.mcp-coding-glm/codex-home/`) chứa
`rules/guard.rules`:

```python
prefix_rule(pattern=["git","commit"], decision="forbidden",
            justification="Pipeline agent must not commit.")
prefix_rule(pattern=["git","push"],   decision="forbidden",
            justification="Pipeline agent must not push.")
```

`CODEX_HOME` riêng là điểm mấu chốt: nó giới hạn lá chắn **chỉ trong tiến trình con**.
Ghi rules vào `~/.codex/rules/` sẽ chặn luôn phiên Codex của chính người dùng — không
chấp nhận được.

Phải đi kèm `-s workspace-write`. Dưới `danger-full-access` lá chắn vô hiệu (issue
#25312), nên vai CODER khoá cứng ở `workspace-write` trong code.

**Dự phòng** nếu `CODEX_HOME` riêng không nạp rules (xem rủi ro mở 13.1): chèn một `git`
giả vào đầu `PATH` của tiến trình con — từ chối `commit`/`push`, chuyển tiếp mọi lệnh
khác tới git thật.

## 10. Xử lý lỗi

| Hỏng gì | Vì sao | Cách đỡ |
|---|---|---|
| Không tìm thấy binary | app GUI không có PATH shell (#4) | giải đường dẫn tuyệt đối lúc khởi động; hỏng thì `capabilities` báo ngay, không chết giữa job |
| JSON sai định dạng | đã quan sát thật (#8) | validate → gửi lại kèm lỗi cụ thể, tối đa 3 lần, hết thì đính kèm output thô |
| Tiến trình con treo | agent lặp vô hạn | timeout theo bước (coder 900s, nghĩ 300s) → giết, đánh dấu `timeout`, đi tiếp task khác |
| Review mãi không pass | task mơ hồ hoặc vượt sức model | hết `maxRounds` → `needs_human`, ghi lại mọi lý do reject, pipeline không treo |
| Provider 429/5xx | gateway dùng chung | dựa `request_max_retries` của Codex rồi mới báo lên |
| Hai job cùng `cwd` | sửa tại chỗ + song song = xung đột | khoá theo `cwd`; job thứ hai bị từ chối, trả `job_id` đang chạy |

### 10.1 Không có lưới an toàn — nêu rõ

Hệ quả trực tiếp của hai lựa chọn của người dùng:

> Sửa **tại chỗ** + **cấm commit** ⟹ GLM phá hỏng thì không có gì để quay về.

Worktree lẽ ra là lưới; đã bỏ. Commit lẽ ra là lưới; đã cấm. Thiết kế **không đảo lại**
lựa chọn đó, mà dựng lưới không vi phạm cả hai ràng buộc:

- Trước mỗi task và sau mỗi vòng, lưu `git diff` ra `jobs/<job_id>/` dạng văn bản thuần
- Thuần đọc — không `commit`, không `stash`, không đụng ref hay index
- Hỏng thì có file patch để `git apply -R` ngược từng bước

**Giới hạn đã biết:** file **chưa từng được git theo dõi** mà bị GLM ghi đè thì
`git diff` không thấy, nên không khôi phục được. Bịt lỗ này cần copy file trước khi
sửa — tốn đĩa. Để sau công tắc `snapshotUntracked`, **mặc định tắt** (người dùng chưa
yêu cầu bật).

## 11. Logging

```
~/.mcp-coding-glm/jobs/<job_id>/
├── job.json                      # trạng thái, danh sách task, mốc thời gian
├── events.jsonl                  # log sự kiện, chỉ ghi thêm
├── split.out                     # output thô của splitter
└── task-03/
    ├── round-1.stdout            # JSONL thô từ codex exec
    ├── round-1.diff              # git diff sau vòng này
    ├── round-1.review.json       # verdict + issues + guidance
    └── round-2.…
```

Nguyên tắc: **giữ transcript thô, không chỉ giữ bản tóm tắt.** Lúc model làm điều kỳ
quặc, thứ cần đọc là nó đã *thực sự* nói gì; bản tóm tắt luôn giấu mất chi tiết gây lỗi.
`pipeline_status({ tail: 50 })` đọc đuôi `events.jsonl`.

## 12. Chiến lược test

Bám quy tắc của người dùng: **không tách hàm chỉ để phục vụ test.** Thiết kế này không
có chỗ nào phải bẻ nhỏ ra để nhét mock.

**Tầng 1 — máy trạng thái, qua binary giả.** Config đã có sẵn trường `binaries` (cần cho
vấn đề PATH ở #4). Test trỏ nó vào script stub in ra JSONL soạn sẵn. Không sửa một dòng
code production nào — dùng đúng khe mà production đang dùng.

Phủ: chia task đúng · JSON hỏng thì sửa lại · hỏng 3 lần thì bỏ cuộc · review fail thì
vòng lại kèm guidance · hết maxRounds thành `needs_human` · timeout thì giết và đi tiếp ·
cancel dừng sạch · khoá `cwd` chặn job trùng. Nhanh, tất định, không tốn API.

**Tầng 2 — lá chắn git.** Khẳng định `codex execpolicy check` trả `forbidden` cho
`git commit`/`git push`, `allow` cho `git status`/`npm test`. Đã chứng minh tay; tự động
hoá để khi nâng cấp Codex mà cú pháp rules đổi thì biết ngay, chứ không phát hiện bằng
cách mất một branch.

**Tầng 3 — smoke test thật, một lần.** Repo git tạm, task bé: *"viết hàm cộng hai số +
test cho nó"*. Chạy thật qua GreenNode. Kiểm những thứ binary giả **không thể** kiểm:
provider nối đúng chưa, `CODEX_HOME` riêng có nạp rules không, diff bắt được không.

Ranh giới giữa tầng 1 và tầng 3 là chỗ dễ tự lừa mình nhất: binary giả chứng minh
**logic điều phối** đúng, nó **không** chứng minh được là ta gọi `codex` đúng cách.
Chỉ tầng 3 nói được điều đó.

## 13. Rủi ro còn mở

1. **`CODEX_HOME` riêng có nạp `rules/` không** — chưa xác minh được (lệnh kiểm bị chặn
   quyền). Suy luận từ #11 nên rất khả năng đúng. Hỏng thì dùng dự phòng `git` giả ở mục 9.
2. **`CODEX_HOME` riêng ảnh hưởng auth** — nhánh GreenNode không sao (key tiêm qua env);
   preset dùng `gpt-5.6-sol` cần symlink `auth.json` từ `~/.codex/`.
3. **Codex đổi cờ CLI** — phụ thuộc thật của hướng spawn-CLI. Test tầng 3 là chuông báo.

## 14. Giả định đã chốt

Người dùng duyệt thiết kế mà chưa trả lời hai câu; chốt mặc định sau, dễ lật lại:

- `maxRounds = 3` — mỗi vòng là một lượt coder chạy lại đầy đủ
- `snapshotUntracked = false` — không copy file untracked trước khi sửa

## 15. Ngoài phạm vi

Cố ý không làm ở vòng này: chạy song song nhiều task · tool research trong MCP · tự
commit/merge · giao diện web · gọi API trực tiếp thay cho spawn CLI · hỗ trợ MCP client
ngoài Codex.
