#!/bin/sh
# Giả lập `codex exec`: ghi FAKE_LAST_MESSAGE vào file sau -o, in JSONL ra stdout.
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
echo '{"type":"item.completed","item":{"type":"agent_message"}}'
if [ -n "$out" ]; then
  if [ -n "$FAKE_LAST_MESSAGE" ]; then
    printf '%s' "$FAKE_LAST_MESSAGE"
  else
    printf '%s' '{"tasks":[]}'
  fi > "$out"
fi
if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi
exit "${FAKE_EXIT:-0}"
