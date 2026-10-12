#!/bin/sh
# Giả lập `codex exec`. Cờ điều khiển, đặt qua env:
#   FAKE_LAST_MESSAGE        nội dung ghi vào file sau -o
#   FAKE_NO_WRITE            cố tình KHÔNG ghi file -o (ghim rmSync)
#   FAKE_EXIT                mã thoát
#   FAKE_SLEEP               ngủ rồi mới thoát — dùng `exec`, xem ghi chú ở cuối file
#   FAKE_BIG_UTF8            số lần lặp chuỗi tiếng Việt ra stdout+stderr (ghim setEncoding)
#   FAKE_GRANDCHILD_PIDFILE  đẻ cháu TRONG nhóm, ghi pid ra file rồi wait (ghim group kill)
#   FAKE_ESCAPED_NODE        đường dẫn node để đẻ cháu THOÁT nhóm (ghim stream destroy)
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
  awk -v n="$FAKE_BIG_UTF8" 'BEGIN{s="lỗi tiếng Việt: ăâêôơưđ ÀÁẠẢÃ ";for(i=0;i<n;i++)printf "%s",s}' >&2
fi
# Cháu NẰM TRONG nhóm tiến trình: chỉ chết nếu runRole giết theo nhóm.
if [ -n "$FAKE_GRANDCHILD_PIDFILE" ]; then
  sleep 30 &
  echo $! > "$FAKE_GRANDCHILD_PIDFILE"
  wait
fi
# Cháu THOÁT khỏi nhóm nhưng vẫn giữ pipe: chỉ thoát được nhờ destroy phía ta.
# Dùng node thay perl/setsid vì macOS không có setsid(1).
if [ -n "$FAKE_ESCAPED_NODE" ]; then
  "$FAKE_ESCAPED_NODE" -e 'require("child_process").spawn("sleep",["8"],{detached:true,stdio:["ignore","inherit","inherit"]}).unref()'
  sleep 5
fi
# `exec` CỐ Ý: thay hẳn shell bằng sleep để leader không sống sót sau khi con chết.
# Đổi về `sleep` thường sẽ làm test timeout đua và đỏ ngẫu nhiên.
if [ -n "$FAKE_SLEEP" ]; then exec sleep "$FAKE_SLEEP"; fi
exit "${FAKE_EXIT:-0}"
