# api-forward-service 模型列表（当前配置）

更新时间：2026-03-16

## 分流规则

- 入口：`POST /v1/chat/completions`
- 命中 `CODEX_MODEL_MATCH=openai-codex/,codex` → 走 Codex 上游
- 其他 model → 走 CUSTOM 上游

## Codex 分支（可用）

以下模型名会命中 Codex 分支：

- `gpt-5.3-codex`
- `gpt-5.4`
- `openai-codex/*`（兼容旧写法）

匹配规则：`CODEX_MODEL_MATCH=openai-codex/,codex,gpt-5.4`

实测：
- `gpt-5.3-codex` ✅ 正常返回
- `gpt-5.4` ✅ 正常返回

## Custom 分支（取决于上游 channel 配置）

理论上你可以传任意非 codex 的 model，例如：

- `custom/glm-5`
- `custom/glm-4.7`
- `custom/gpt-5.2`

实测：
- `custom/glm-5` ❌ 返回 `没有支持该模型的channel`

说明：这个报错来自 CUSTOM 上游（`CUSTOM_UPSTREAM_BASE_URL=https://aihub-in.gz4399.com/v1`），不是 api-forward-service 本身。

## 快速自测

```bash
BASE_URL=http://127.0.0.1:43111 \
SERVICE_TOKEN=<FORWARD_SERVICE_TOKEN> \
bash ./examples_call.sh
```
