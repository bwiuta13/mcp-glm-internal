#!/bin/sh
# Giả lập `codex exec`: ghi FAKE_LAST_MESSAGE vào file sau -o, in JSONL ra stdout.
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
echo '{"type":"item.completed","item":{"type":"agent_message"}}'
# KHÔNG dùng "${FAKE_LAST_MESSAGE:-{...}}": trong POSIX sh dấu } đầu tiên đóng ${...},
# dấu } thứ hai thành ký tự thường, nên khi biến có giá trị sẽ in thừa một }.
if [ -n "$FAKE_NO_WRITE" ]; then
  :   # cố tình không ghi -o, để test ghim được rmSync
elif [ -n "$out" ]; then
  if [ -n "$FAKE_LAST_MESSAGE" ]; then
    printf '%s' "$FAKE_LAST_MESSAGE"
  else
    printf '%s' '{"tasks":[]}'
  fi > "$out"
fi
# Đổ nhiều văn bản tiếng Việt ra stdout để ghim setEncoding: ký tự nhiều byte bị cắt
# ngang ranh giới chunk sẽ thành U+FFFD nếu decode từng chunk rời.
if [ -n "$FAKE_BIG_UTF8" ]; then
  awk -v n="$FAKE_BIG_UTF8" 'BEGIN{s="nhiều ký tự tiếng Việt: ăâêôơưđ ÀÁẠẢÃ ";for(i=0;i<n;i++)printf "%s",s}'
fi
if [ -n "$FAKE_SLEEP" ]; then exec sleep "$FAKE_SLEEP"; fi
exit "${FAKE_EXIT:-0}"
