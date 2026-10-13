# Smoke test (tầng 3 — chạy tay)

Binary giả chứng minh logic điều phối đúng. Nó **không** chứng minh ta gọi `codex` đúng
cách. Chỉ bài này nói được điều đó. Chạy sau khi cài, và sau mỗi lần nâng cấp Codex.

## 1. Chuẩn bị

```bash
mkdir -p /tmp/mcg-smoke && cd /tmp/mcg-smoke
git init && git commit --allow-empty -m init
```

## 2. Kiểm config nạp được

```bash
node -e "import('./src/config.ts').then(m=>console.log(JSON.stringify(m.loadConfig(),null,1)))"
```

Kỳ vọng: in ra config, không ném lỗi.

## 3. Kiểm lá chắn git thật sự áp vào tiến trình con

```bash
npm test -- --test-name-pattern "rules chặn git"
```

Kỳ vọng: PASS, không `skip`. Nếu `skip` thì chưa có `~/.mcp-coding-glm/config.json`.

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
- [ ] `git log` **không có commit mới** — lá chắn đã làm việc
- [ ] `~/.mcp-coding-glm/jobs/<job_id>/task-1/round-1.diff` có nội dung
- [ ] `~/.codex/rules/` **không** bị thêm file nào — lá chắn đúng phạm vi

## 6. Nếu bước 5 có mục nào hỏng

Rủi ro đã biết trong spec mục 13: nếu `CODEX_HOME` riêng không nạp `rules/`, chuyển sang
phương án dự phòng — chèn một `git` giả vào đầu `PATH` của tiến trình con, từ chối
`commit`/`push` và chuyển tiếp mọi lệnh khác tới git thật.
