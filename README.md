# api-forward-service（龙虾接入版）

这份文档只讲一件事：**怎么把这个服务接进龙虾（OpenClaw）里用**。

---

## 1) 启动转发服务

```bash
cd /home/shash/clawd/apps/api-forward-service
cp .env.example .env
# 按你的环境填写 .env
set -a && source .env && set +a
npm run start
```

服务默认监听：`http://127.0.0.1:43111`

健康检查：

```bash
curl http://127.0.0.1:43111/health
```

返回 `ok: true` 再进行下一步。

---

## 2) 在龙虾里配置这个转发入口

在龙虾配置中新增一个 **OpenAI 兼容 provider**，核心只要两项：

- `baseUrl`: `http://127.0.0.1:43111`
- `apiKey`: 你在 `.env` 里配置的 `FORWARD_SERVICE_TOKEN`

> 说明：龙虾侧请求会打到本服务的 `POST /v1/chat/completions`，由本服务按 `model` 做分流。

建议把你要在龙虾里使用的模型名加到默认可选模型中（例如 `codex-forward/gpt-5.3-codex` 这一类），并设为主模型或可选模型。

---

## 3) 验证龙虾是否已走转发链路

在龙虾里发起一条正常对话，然后看本服务日志：

- 有请求日志（包含 `POST /v1/chat/completions`）
- 能看到对应的 `model` 字段
- 返回状态为 200

只要日志出现，说明龙虾已经通过这层转发服务在工作。

---

## 4) 作为常驻服务运行（可选）

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

启用：

```bash
systemctl --user daemon-reload
systemctl --user enable --now api-forward-service
systemctl --user status api-forward-service
```

---

## 5) 你只需要记住的三件事

1. 先让 `api-forward-service` 本身健康运行。
2. 龙虾 provider 指向 `http://127.0.0.1:43111`，并带 `FORWARD_SERVICE_TOKEN`。
3. 在龙虾里实际发一条消息，确认转发服务日志里有命中记录。
