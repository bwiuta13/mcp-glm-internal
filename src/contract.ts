import * as z from 'zod';

export const TaskListSchema = z.object({
  tasks: z
    .array(
      z.object({
        id: z.coerce.string(),
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
        file: z.string().optional(),
        line: z.number().int().optional(),
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
  let text = raw.trim();

  // Đã quan sát thật: glm-5.2 trả JSON bọc trong hàng rào markdown.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    text = fence[1].trim();
  } else {
    const start = text.search(/[[{]/);
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      repairPrompt:
        `Your previous reply was not valid JSON (${(e as Error).message}). ` +
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
