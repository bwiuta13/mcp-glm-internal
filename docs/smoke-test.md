# Smoke test (tầng 3 — chạy tay)

Binary giả chứng minh logic điều phối đúng. Nó **không** chứng minh ta gọi `codex` đúng
cách. Chỉ bài này nói được điều đó. Chạy sau khi cài, và sau mỗi lần nâng cấp Codex.

## 1. Chuẩn bị

```bash
rm -rf /tmp/mcg-smoke            # dọn sạch: sum.js còn sót từ lần trước làm bước 5 xanh giả
mkdir -p /tmp/mcg-smoke && cd /tmp/mcg-smoke
git init && git commit --allow-empty -m init
ls ~/.codex/rules/               # ghi lại để bước 5 đối chiếu lá chắn không rò ra ngoài
```

## 2. Kiểm config nạp được

Chạy từ **thư mục repo**, không phải từ `/tmp/mcg-smoke` của bước 1:

```bash
cd /Users/lap14568/mcp-coding-glm
node -e "import('./src/config.ts').then(m=>console.log(JSON.stringify(m.loadConfig(),null,1)))"
```

Kỳ vọng: in ra config, không ném lỗi.

## 3. Kiểm lá chắn git thật sự áp vào tiến trình con

```bash
node --test --test-name-pattern="rules chặn git" test/guard.test.ts
```

Kỳ vọng: PASS, không `skip`. `npm test -- --test-name-pattern ...` **không lọc được** —
cờ bị nối sau glob nên Node đưa nó cho chính file test và cả bộ 76 test đều chạy.
`skip` nghĩa là không tìm thấy binary `codex` (test tự dò qua `CODEX_BIN` hoặc PATH),
**không** phải thiếu config.

## 4. Chạy pipeline thật, một task bé

Trong Codex, ở thư mục `/tmp/mcg-smoke`:

```
$start-task
```

với plan: *"Tạo file sum.js xuất hàm sum(a,b) trả a+b, và sum.test.js kiểm nó bằng node:test."*

## 5. Những điều phải xác nhận

- [ ] `pipeline_start` trả `job_id` **ngay**, không treo
- [ ] `pipeline_status` cho thấy task chuyển `coding` → `reviewing` → `passed`
- [ ] File thật được tạo trong `/tmp/mcg-smoke`
- [ ] **Kiểm lá chắn git theo kiểu đối nghịch.** Chỉ xem `git log` trống là vô nghĩa:
      prompt đã bảo coder đừng commit, nên nó không bao giờ thử, và phép kiểm này vẫn
      xanh kể cả khi lá chắn hỏng hoàn toàn. Phải tự ép nó thử:

      ```bash
      CODEX_HOME=~/.mcp-coding-glm/codex-home codex exec -s workspace-write \
        -C /tmp/mcg-smoke --skip-git-repo-check \
        "Run exactly this and report the output verbatim: git commit --allow-empty -m probe"
      ```

      Phải thấy lệnh bị từ chối kèm lý do `no commit`, và `git log` chỉ có commit `init`.
- [ ] `~/.mcp-coding-glm/jobs/<job_id>/task-1/round-1.diff` có nội dung
- [ ] `~/.codex/rules/` **không** bị thêm file nào — lá chắn đúng phạm vi

## 6. Nếu bước 5 có mục nào hỏng

Rủi ro đã biết trong spec mục 13: nếu `CODEX_HOME` riêng không nạp `rules/`, chuyển sang
phương án dự phòng — chèn một `git` giả vào đầu `PATH` của tiến trình con, từ chối
`commit`/`push` và chuyển tiếp mọi lệnh khác tới git thật.
