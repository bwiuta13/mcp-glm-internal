#!/bin/sh
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="$HOME/.mcp-coding-glm"
SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"

# `|| true` là bắt buộc: dưới `set -e`, command -v thất bại sẽ giết script NGAY tại dòng
# gán, nên thông báo lỗi bên dưới không bao giờ được in ra.
NODE_BIN="$(command -v node || true)"
CODEX_BIN="$(command -v codex || true)"

if [ -z "$NODE_BIN" ]; then echo "node không có trên PATH" >&2; exit 1; fi
if [ -z "$CODEX_BIN" ]; then echo "codex không có trên PATH — cài codex rồi chạy lại" >&2; exit 1; fi

# Kiểm phiên bản TRƯỚC khi ghi gì: dưới 22.18 Node không chạy thẳng .ts được.
"$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number);
if (a<22 || (a===22 && b<18)) { console.error("cần Node >= 22.18, đang có "+process.versions.node); process.exit(1); }' || exit 1

# Thiếu node_modules thì server đăng ký xong vẫn chết ngay ở câu import đầu tiên.
[ -d "$REPO/node_modules" ] || (cd "$REPO" && npm ci --omit=dev)

# Provider `openai` xác thực qua CODEX_HOME, mà pipeline chạy tiến trình con dưới một
# CODEX_HOME RIÊNG. Đo thật: guard home không có auth.json -> 401 Unauthorized. Nên chỉ
# chọn preset dùng `openai` khi người dùng thật sự có auth.json để nối vào.
if [ -f "${CODEX_HOME:-$HOME/.codex}/auth.json" ]; then
  THINK_PROVIDER='openai'
  THINK_MODEL='gpt-5.6-sol'
  echo "Có auth.json — vai nghĩ dùng gpt-5.6-sol (khác model với coder nên review tốt hơn)."
else
  THINK_PROVIDER='greennode'
  THINK_MODEL='z-ai/glm-5.3'
  echo "Không có auth.json của codex — vai nghĩ dùng z-ai/glm-5.3 qua GreenNode."
  echo "  (Đăng nhập codex rồi chạy lại để đổi sang gpt-5.6-sol.)"
fi

# 1. Thư mục config + mẫu, nếu chưa có
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/config.json" ]; then
  cat > "$CONFIG_DIR/config.json" <<JSON
{
  "binaries": {
    "codex": "$CODEX_BIN"
  },
  "providers": {
    "greennode": {
      "baseUrl": "https://tokenplan.api.greennode.ai/v1",
      "apiKeyEnv": "GREENNODE_API_KEY"
    }
  },
  "roles": {
    "splitter": { "runner": "codex", "provider": "$THINK_PROVIDER", "model": "$THINK_MODEL" },
    "reviewer": { "runner": "codex", "provider": "$THINK_PROVIDER", "model": "$THINK_MODEL" },
    "coder":    { "runner": "codex", "provider": "greennode", "model": "z-ai/glm-5.3" }
  },
  "maxRounds": 3,
  "timeouts": { "splitter": 300, "reviewer": 300, "coder": 900 },
  "snapshotUntracked": false
}
JSON
  echo "Wrote $CONFIG_DIR/config.json — check the binary path before first run."
fi

# 2. Copy skill
# "${d%/}" — KHÔNG để dấu / ở cuối: BSD cp khi đó chép NỘI DUNG thư mục chứ không chép
# thư mục, nên ~/.codex/skills chỉ nhận được SKILL.md rời và KHÔNG có skill nào tồn tại.
mkdir -p "$SKILLS_DIR"
for d in "$REPO"/skills/*/; do
  cp -R "${d%/}" "$SKILLS_DIR/"
done
for want in start-task task-status task-stop; do
  if [ ! -f "$SKILLS_DIR/$want/SKILL.md" ]; then
    echo "ERROR: skill '$want' did not install into $SKILLS_DIR" >&2
    exit 1
  fi
done
echo "Installed 3 skills into $SKILLS_DIR"

# 3. Đăng ký MCP — đường dẫn tuyệt đối vì app GUI không có PATH shell.
# KHÔNG remove-rồi-add nếu đã đăng ký: thao tác đó xoá sạch API key người dùng đã dán
# và mọi thiết lập riêng của họ trong config.toml.
if codex mcp get coding-glm >/dev/null 2>&1; then
  echo "MCP server 'coding-glm' đã đăng ký — giữ nguyên thiết lập hiện có."
  echo "Muốn đăng ký lại: codex mcp remove coding-glm && ./scripts/install.sh"
else
  if [ -z "${GREENNODE_API_KEY:-}" ]; then
    echo "CẢNH BÁO: GREENNODE_API_KEY đang rỗng. Dán vào mục env của"
    echo "         [mcp_servers.coding-glm] trong ~/.codex/config.toml sau khi cài." >&2
  fi
  codex mcp add coding-glm \
    --env "GREENNODE_API_KEY=${GREENNODE_API_KEY:-}" \
    -- "$NODE_BIN" "$REPO/src/index.ts"
fi

echo
echo "Done. Verify with:  codex mcp list"
echo "Set GREENNODE_API_KEY in ~/.codex/config.toml under the coding-glm server env if it is empty."
