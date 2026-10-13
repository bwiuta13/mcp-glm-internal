#!/bin/sh
# Trả phản hồi thứ N từ FAKE_SCRIPT_DIR, tăng bộ đếm sau mỗi lần gọi.
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
d="$FAKE_SCRIPT_DIR"
n=$(cat "$d/counter" 2>/dev/null || echo 0)
body=$(cat "$d/$n.txt" 2>/dev/null || echo '')
echo $((n + 1)) > "$d/counter"
echo '{"type":"item.completed"}'
if [ -n "$out" ]; then printf '%s' "$body" > "$out"; fi
exit 0
