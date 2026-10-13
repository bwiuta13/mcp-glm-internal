#!/bin/sh
# Trả phản hồi thứ N từ FAKE_SCRIPT_DIR, tăng bộ đếm sau mỗi lần gọi, và GHI LẠI từng
# lượt vào calls.log để test khẳng định được prompt và sandbox — bản cũ bỏ qua argv nên
# test không thể bắt được việc gọi thừa hay prompt sai.
#   FAKE_HOLD_ON=<n>  giữ lượt thứ n lại (để test huỷ đúng điểm await)
#   FAKE_HOLD         giữ bao lâu, mặc định 10s
#   FAKE_TOUCH        tạo file mới ở đường dẫn này (để test diff thấy file mới)
out=""
prev=""
sandbox=""
prompt=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  if [ "$prev" = "-s" ]; then sandbox="$a"; fi
  prompt="$a"
  prev="$a"
done
d="$FAKE_SCRIPT_DIR"
n=$(cat "$d/counter" 2>/dev/null || echo 0)
body=$(cat "$d/$n.txt" 2>/dev/null || echo '')
echo $((n + 1)) > "$d/counter"
{ echo "CALL $n sandbox=$sandbox"; echo "$prompt"; echo "==="; } >> "$d/calls.log"
if [ "$sandbox" = "workspace-write" ] && [ -n "$FAKE_TOUCH" ]; then echo 'noi dung moi' > "$FAKE_TOUCH"; fi
if [ "$FAKE_HOLD_ON" = "$n" ]; then sleep "${FAKE_HOLD:-10}"; fi
echo '{"type":"item.completed"}'
if [ -n "$out" ]; then printf '%s' "$body" > "$out"; fi
exit 0
