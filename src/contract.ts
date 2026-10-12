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
        line: z.number().int().nullish(),
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
    // Dấu mở không bao giờ đóng (payload bị cắt cụt): mọi dấu mở phía sau đều nằm bên
    // trong nó, quét tiếp chỉ tốn thời gian mà không đổi kết quả.
    if (!closed) break;
  }

  if (!found) {
    return {
      ok: false,
      repairPrompt:
        `Your previous reply was not valid JSON (${firstError}). ` +
        `Reply with JSON only — no prose, no markdown fences.`,
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
      `Fix exactly these problems and reply with JSON only:\n${detail}`,
  };
}
