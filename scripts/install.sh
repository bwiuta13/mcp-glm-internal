#!/bin/sh
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
CONFIG_DIR="$HOME/.mcp-coding-glm"
SKILLS_DIR="$HOME/.codex/skills"

if [ -z "$NODE_BIN" ]; then echo "node not found on PATH"; exit 1; fi

# 1. Thư mục config + mẫu, nếu chưa có
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/config.json" ]; then
  cat > "$CONFIG_DIR/config.json" <<JSON
{
  "binaries": {
    "codex": "$(command -v codex || echo /path/to/codex)"
  },
  "providers": {
    "greennode": {
      "baseUrl": "https://tokenplan.api.greennode.ai/v1",
      "apiKeyEnv": "GREENNODE_API_KEY"
    }
  },
  "roles": {
    "splitter": { "runner": "codex", "provider": "openai", "model": "gpt-5.6-sol", "effort": "xhigh" },
    "reviewer": { "runner": "codex", "provider": "openai", "model": "gpt-5.6-sol", "effort": "xhigh" },
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
mkdir -p "$SKILLS_DIR"
for d in "$REPO"/skills/*/; do
  cp -R "$d" "$SKILLS_DIR/"
done
echo "Installed skills into $SKILLS_DIR"

# 3. Đăng ký MCP — đường dẫn tuyệt đối vì app GUI không có PATH shell
codex mcp remove coding-glm 2>/dev/null || true
codex mcp add coding-glm \
  --env "GREENNODE_API_KEY=${GREENNODE_API_KEY:-}" \
  -- "$NODE_BIN" "$REPO/src/index.ts"

echo
echo "Done. Verify with:  codex mcp list"
echo "Set GREENNODE_API_KEY in ~/.codex/config.toml under the coding-glm server env if it is empty."
