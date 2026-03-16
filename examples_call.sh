#!/usr/bin/env bash
set -euo pipefail

# 用法：
#   BASE_URL=http://127.0.0.1:43111 \
#   SERVICE_TOKEN=xxxxx \
#   bash examples_call.sh

BASE_URL="${BASE_URL:-http://127.0.0.1:43111}"
SERVICE_TOKEN="${SERVICE_TOKEN:-REPLACE_WITH_FORWARD_SERVICE_TOKEN}"
# 当前部署建议：CODEX_OAUTH_ENABLED=true，由服务端 OAuth token 调上游。

post_chat() {
  local model="$1"
  local prompt="$2"

  curl -sS -X POST "${BASE_URL}/v1/chat/completions" \
    -H "Authorization: Bearer ${SERVICE_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${model}\",\"messages\":[{\"role\":\"user\",\"content\":\"${prompt}\"}],\"temperature\":0.2,\"max_tokens\":128}"
  echo
}

echo "== health =="
curl -sS "${BASE_URL}/health"
echo -e "\n"

echo "== codex model example =="
post_chat "gpt-5.3-codex" "你是谁？请简短回答。"

echo "== custom model example =="
post_chat "glm-5" "请只回复: API_OK"
