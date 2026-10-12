#!/bin/sh
# Ghi argv và vài biến env ra $RECORD_TO để test kiểm chứng cờ an toàn của runRole.
out="$RECORD_TO"
{
  echo "ARGV_BEGIN"
  for a in "$@"; do printf '%s\n' "$a"; done
  echo "ARGV_END"
  echo "CODEX_HOME=$CODEX_HOME"
  echo "PATH=$PATH"
} > "$out"
exit 0
