# API Forward Service

独立转发服务（Node.js），先做你要的两段：

1. **自定义 API 包装转发**
   - 统一入口：`POST /v1/chat/completions`
   - 当 `model` 不命中 Codex 规则时，转发到：`CUSTOM_UPSTREAM_BASE_URL + CUSTOM_UPSTREAM_CHAT_PATH`

2. **Codex 授权转发（同一路径按 model 分流）**
   - 统一入口仍是：`POST /v1/chat/completions`
   - 当 `model` 命中 `CODEX_MODEL_MATCH` 时，转发到：`CODEX_UPSTREAM_BASE_URL + CODEX_UPSTREAM_CHAT_PATH`
   - 默认要求客户端带 `Authorization: Bearer <token>`

## 启动

```bash
cd apps/api-forward-service
cp .env.example .env
# 编辑 .env
set -a && source .env && set +a
npm run start
```

## 健康检查

```bash
curl http://127.0.0.1:43111/health
```

## 独立 OAuth 授权（可选）

> 适用于你希望转发服务自己持有 Codex OAuth，不依赖 OpenClaw 本地链路。

1) 在 `.env` 填好 OAuth 参数，并设置 `CODEX_OAUTH_ENABLED=true`

2) 发起授权（推荐标准鉴权头）

```bash
curl -H "Authorization: Bearer <service-token>" \
  "http://127.0.0.1:43111/oauth/start"
```

返回里有 `authorizeUrl`，浏览器打开后完成授权。

3) 授权回调到 `/oauth/callback`，服务端会写入 token 文件（默认 `./codex-oauth-token.json`）

4) 查看状态

```bash
curl -H "Authorization: Bearer <service-token>" \
  "http://127.0.0.1:43111/oauth/status"
```

> 兼容：仍支持旧头 `X-Forward-Token`，但建议迁移到标准 `Authorization: Bearer`。

## 分流规则

- 请求 `POST /v1/chat/completions`
- 从请求体读取 `model`
- 如果 `model` 包含任一 `CODEX_MODEL_MATCH` 关键字（默认：`openai-codex/,codex`），走 Codex 上游
- 否则走自定义 API 上游

## systemd（用户级）部署示例

`~/.config/systemd/user/api-forward-service.service`

```ini
[Unit]
Description=API Forward Service
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/shash/clawd/apps/api-forward-service
EnvironmentFile=/home/shash/clawd/apps/api-forward-service/.env
ExecStart=/usr/bin/node /home/shash/clawd/apps/api-forward-service/server.mjs
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now api-forward-service
systemctl --user status api-forward-service
```
