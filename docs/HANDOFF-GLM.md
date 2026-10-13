> **Historical hand-off document (tài liệu bàn giao lịch sử)** — its status lines (test counts, branch name, the "Còn lại" task list) are no longer current; see `README.md` and `git log` for the real state.

# Bàn giao cho GLM — mcp-coding-glm

Repo: `/Users/lap14568/mcp-coding-glm` · nhánh `feat/mcp-coding-glm`
Kế hoạch đầy đủ: `docs/superpowers/plans/2026-10-12-mcp-coding-glm.md`
Spec: `docs/superpowers/specs/2026-10-12-mcp-coding-glm-design.md`

**Mỗi task trong kế hoạch đã có sẵn code hoàn chỉnh và file test hoàn chỉnh.** Việc của bạn
là chép đúng nguyên văn, chạy test, rồi commit. Không tự sáng tác lại.

---

## Mục tiêu tổng thể

Một MCP server chạy local để **Codex làm nhạc trưởng** điều phối pipeline coding nhiều model:

```
Bạn chat với Codex  →  Codex research + lập plan  →  bạn gõ $start-task
                                                          ↓
      MCP: SPLIT → (CODE → REVIEW → FIX)×N → done     (job bất đồng bộ, poll trạng thái)
                     ↑                ↑
                    GLM            model khác
```

MCP **không tự nghĩ và không tự sửa file**. Nó xếp lịch, spawn CLI con, kiểm JSON, ghi log.
Mọi suy luận nằm trong `codex`/`claude` đã đăng nhập sẵn.

---

## Đã xong — KHÔNG được sửa

| Task | Module | Export sẵn dùng |
|---|---|---|
| 1 | `src/config.ts` | `ROLE_SANDBOX`, `Role`, `Config`, `loadConfig`, `DEFAULT_CONFIG_PATH` |
| 2 | `src/contract.ts` | `TaskListSchema`, `ReviewSchema`, `TaskItem`, `Review`, `parseContract` |
| 3 | `src/runner.ts` | `GUARD_RULES`, `ensureGuardHome`, `RunResult`, `RunOpts`, `runRole` |
| 4 | `src/jobs.ts` | `JobState`, `TaskState`, `JobTask`, `Job`, `createJob`, `getJob`, `appendEvent`, `readTail`, `releaseJob`, `cancelJob` |

Trạng thái: **57/57 test xanh**. Chạy `npm test` để xác nhận trước khi bắt đầu.

---

## Còn lại

### Task 5 — Máy trạng thái pipeline  ⚠️ nặng nhất
**Mục tiêu:** nối mọi mảnh lại. Nhận plan → chia task → với mỗi task lặp CODE→REVIEW→FIX
đến khi đạt hoặc hết `maxRounds`, rồi đánh dấu xong.

- Tạo: `src/pipeline.ts`, `test/pipeline.test.ts`, `test/fixtures/scripted-codex.sh`
- Xuất: `runPipeline(job, cfg, opts?): Promise<void>`
- Prompt template nằm NGAY TRONG file này, không tách module riêng
- **Xong khi:** `dryRun` chỉ chia task rồi dừng · review pass → task `passed` · review fail
  hết `maxRounds` → `needs_human` nhưng pipeline **đi tiếp task khác, không treo** ·
  splitter trả JSON hỏng 3 lần → job `failed` · chụp `git diff` làm mốc trước mỗi task

### Task 6 — Wiring MCP server
**Mục tiêu:** phơi 5 tool qua stdio để Codex gọi được.

- Tạo: `src/index.ts`, `test/server.test.ts`
- Tool: `pipeline_start`, `pipeline_status`, `pipeline_result`, `pipeline_cancel`, `capabilities`
- **Xong khi:** bắt tay JSON-RPC được, `tools/list` trả đúng 5 tên, và mô tả của
  `pipeline_start` có nhắc điều kiện `$start-task`

### Task 7 — Ba skill Codex
**Mục tiêu:** cửa chặn thủ công — Codex không được tự khởi động pipeline.

- Tạo: `skills/{start-task,task-status,task-stop}/SKILL.md` + `agents/openai.yaml`
- **Xong khi:** `start-task` và `task-stop` có `policy.allow_implicit_invocation: false`,
  `task-status` là `true`

### Task 8 — Script cài + smoke test
**Mục tiêu:** một lệnh cài xong, và một quy trình kiểm thật.

- Tạo: `scripts/install.sh`, `docs/smoke-test.md`
- **Xong khi:** `install.sh` ghi config mẫu, copy skill, chạy `codex mcp add` với
  **đường dẫn tuyệt đối**

---

## Ràng buộc BẮT BUỘC — vi phạm là hỏng thật

1. **Không có bước build.** Node 22.18+ chạy `.ts` trực tiếp. Không `tsc`, không `tsx`,
   không `tsconfig.json`.
2. **Package MCP là `@modelcontextprotocol/server`** (v2.3.1), KHÔNG phải `...../sdk`.
   `inputSchema` nhận **raw shape** `{ x: z.string() }`, không phải `z.object({...})`.
3. **`node --test` không nhận thư mục** — phải dùng glob: `node --test "test/**/*.test.ts"`.
4. **Vai CODER luôn `-s workspace-write`.** TUYỆT ĐỐI không `danger-full-access` — nó gỡ
   **cả hai lớp** lá chắn git cùng lúc (execpolicy + sandbox). Đã kiểm bằng thực nghiệm.
5. **Agent không bao giờ được `git commit` / `git push`.** Chặn cứng bằng execpolicy trong
   `CODEX_HOME` riêng, không phải bằng lời dặn trong prompt.
6. **Không dùng structured output phía provider.** Gateway nhận `json_schema` nhưng không
   tuân thủ. Dùng prompt + `parseContract` + vòng sửa.
7. **Task chạy tuần tự**, một job cho mỗi `cwd`.
8. **Giết tiến trình phải giết theo NHÓM** (`process.kill(-pid)`), không phải `child.kill()`.
   Sai chỗ này thì coder có quyền ghi file sống sót thành mồ côi.
9. **QUY TẮC CAO NHẤT của chủ repo:** *không được tách hàm chỉ để phục vụ file test; hàm nào
   dùng một lần và chỉ hỗ trợ một việc đặc thù thì không được tách.* Giữ logic inline tại
   chỗ gọi, kể cả khi hàm bao dài ra.

---

## Cách làm từng task

1. Mở kế hoạch, tìm đúng `### Task N`
2. **Viết file test TRƯỚC**, chạy `npm test`, xác nhận nó ĐỎ vì đúng lý do mong đợi
3. Chép code production, chạy lại, xác nhận XANH
4. Chạy `npm test` **ít nhất 3 lần** — vài test có liên quan thời gian và tiến trình thật
5. Commit, kèm dòng cuối:
   `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## Những thứ đã được sửa SẴN trong kế hoạch Task 5 — đừng áp lại

Các mục dưới đây là kết quả review của task trước và **đã nằm trong kế hoạch rồi**. Chép
đúng nguyên văn là có. Liệt kê ở đây để bạn hiểu vì sao code trông như vậy, và để đừng
"dọn dẹp" chúng đi:

- **Thư mục log đặt theo VỊ TRÍ** (`task-1-<id>`), không theo `id`. Hai task trùng `id`,
  hoặc `"A"` và `"a"` trên APFS không phân biệt hoa thường, sẽ đụng chung thư mục và ghi
  đè nhau.
- **`job.tasks` là MẢNG**, không phải object keyed by id — `id` có thể là `"__proto__"`.
- **Bốn điểm `if (job.state === 'cancelled') return;`** sau mỗi `await`. Thiếu chúng thì
  sau khi người dùng thấy "Cancelled", coroutine vẫn spawn con `workspace-write` MỚI,
  trong khi một job khác có thể đã chiếm khoá thư mục đó.
- **`onSpawn` dọn con khi `'close'`.** Không dọn thì `cancelJob` bắn SIGKILL vào pid đã
  thoát; pid bị tái dùng là giết nhầm nhóm tiến trình lạ.
- **`catch` không được ghi đè `'cancelled'` thành `'failed'`.**

## Báo cáo

Nói đúng những gì bạn **đã chạy và đã thấy**. Nếu một test vẫn xanh kể cả khi xoá đoạn code
nó nhắm tới, hãy nói thẳng là nó chưa ghim được gì, đừng khai là đã ghim.
