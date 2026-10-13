import * as z from 'zod';

export const TaskListSchema = z.object({
  tasks: z
    .array(
      z.object({
        // Chỉ ép SỐ về chuỗi (đã quan sát glm-5.2 trả id kiểu số). Ép mọi thứ sẽ
        // biến null thành "null" và object thành "[object Object]" — mà id này đi
        // thẳng vào tên thư mục log `task-<id>` và bộ lọc `only` của Task 5.
        // Ràng buộc bộ ký tự, không chỉ "chuỗi không rỗng": Task 5 dựng tên thư mục
        // log `task-<id>`, nên "../../../x" hay "a/b" sẽ thoát ra ngoài thư mục job.
        id: z.preprocess(
          (v) => (typeof v === 'number' ? String(v) : v),
          z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        ),
        title: z.string().min(1),
        detail: z.string().min(1),
        files: z.array(z.string()),
        acceptance: z.string().min(1),
      }),
    )
    .min(1),
});

export const ReviewSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  issues: z
    .array(
      z.object({
        severity: z.enum(['blocker', 'major', 'minor']),
        // LLM thường trả null cho field vắng mặt. Từ chối null ở đây tốn nguyên
        // một lượt reviewer chạy lại, nên nhận cả null lẫn undefined.
        file: z.string().nullish(),
        // `line` chỉ để người đọc, không logic nào dùng tới: từ chối cả bản review vì
        // "line":"3" (chuỗi số) là đốt một lượt reviewer cho một field thẩm mỹ — cùng lý do với
        // null ở trên. Ép về số thay vì bắt chạy lại. `nullish()` đứng NGOÀI coerce nên null vẫn
        // là null; ép trước sẽ biến nó thành 0.
        line: z.coerce.number().int().nullish(),
        message: z.string(),
      }),
    )
    .default([]),
  guidance: z.string().default(''),
});

export type TaskItem = z.infer<typeof TaskListSchema>['tasks'][number];
export type Review = z.infer<typeof ReviewSchema>;

export type ContractResult<T> = { ok: true; value: T } | { ok: false; repairPrompt: string };

export function parseContract<T>(raw: string, schema: z.ZodType<T>): ContractResult<T> {
  const text = raw.trim();

  // Mỗi lượt chạy là một `codex exec` MỚI, không có lịch sử hội thoại: câu sửa nói "câu trả lời
  // trước của bạn sai" mà không kèm chính câu đó thì model không có gì để sửa. Cắt ở 4000 ký tự
  // để câu sửa không phình theo câu trả lời hỏng (thường là cả một payload bị cắt cụt).
  const clipped = text.length > 4000
    ? `${text.slice(0, 4000)}\n[... truncated ${text.length - 4000} more characters]`
    : text || '(empty)';
  const rejected = `\n\nYour previous reply was:\n<rejected_reply>\n${clipped}\n</rejected_reply>`;

  // Output của model là prose, hàng rào ``` và JSON trộn theo thứ tự bất kỳ — và một
  // giá trị chuỗi TRONG JSON hoàn toàn có thể chứa khối ``` của chính nó, vì ta bảo
  // splitter viết `detail` đủ chi tiết và bảo reviewer viết `guidance`. Nên khớp hàng
  // rào bằng regex, hay cắt từ dấu mở đầu tới dấu đóng cuối, đều phá hỏng payload hợp lệ.
  // Thay vào đó: thử cả chuỗi trước, rồi quét tìm span {...} hoặc [...] cân bằng đầu tiên
  // parse được, với bộ đếm độ sâu biết bỏ qua dấu nằm trong chuỗi.
  let data: unknown;
  let found = false;
  let firstError = '';

  try {
    data = JSON.parse(text);
    found = true;
  } catch (e) {
    firstError = (e as Error).message;
  }

  for (let i = 0; i < text.length && !found; i++) {
    const open = text[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closed = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        inString = true;
      } else if (c === open) {
        depth++;
      } else if (c === close) {
        depth--;
        if (depth === 0) {
          closed = true;
          try {
            data = JSON.parse(text.slice(i, j + 1));
            found = true;
          } catch {
            // Span cân bằng nhưng không phải JSON: bỏ qua CẢ span. Thử lại từng dấu mở
            // bên trong nó vừa cho chẩn đoán sai — một mảnh con parse được sẽ thắng, và
            // câu sửa đi nói về mảnh con thay vì nói về lỗi cú pháp thật — vừa làm vòng
            // quét thành O(n^2).
            i = j;
          }
          break;
        }
      }
    }
    // Dấu mở không bao giờ đóng (payload bị cắt cụt): dừng quét ở đây. Đây là MỘT ĐÁNH ĐỔI CÓ
    // CHỦ ĐÍCH, không phải tối ưu miễn phí — quét tiếp THÌ KẾT QUẢ CÓ ĐỔI: `prose { oops\n[{"a":1}]`
    // bị bỏ sót, vì dấu `{` lẻ đứng trước nuốt mất mảng hợp lệ đứng sau nó. Ta chấp nhận mất ca
    // đó để giữ vòng quét tuyến tính: thử lại từng dấu mở phía sau một dấu mở không đóng là
    // O(n^2), mà payload cắt cụt có thể chứa hàng nghìn dấu mở. Câu sửa sẽ bảo model trả JSON thuần.
    if (!closed) break;
  }

  if (!found) {
    return {
      ok: false,
      repairPrompt:
        `Your previous reply was not valid JSON (${firstError}). ` +
        `Reply with JSON only — no prose, no markdown fences.${rejected}`,
    };
  }

  const parsed = schema.safeParse(data);
  if (parsed.success) return { ok: true, value: parsed.data };

  // Câu sửa phải gọi đích danh từng vấn đề; "sai rồi, làm lại" không đủ để model sửa đúng.
  const detail = parsed.error.issues
    .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  return {
    ok: false,
    repairPrompt:
      `Your previous JSON did not match the required shape. ` +
      `Fix exactly these problems and reply with JSON only:\n${detail}${rejected}`,
  };
}
