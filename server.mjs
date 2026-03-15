import http from "node:http";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const env = process.env;
const HOST = env.HOST || "0.0.0.0";
const PORT = Number(env.PORT || 43111);

const CUSTOM_UPSTREAM_BASE_URL = env.CUSTOM_UPSTREAM_BASE_URL || "";
const CUSTOM_UPSTREAM_CHAT_PATH = env.CUSTOM_UPSTREAM_CHAT_PATH || "/v1/chat/completions";
const CUSTOM_UPSTREAM_API_KEY = env.CUSTOM_UPSTREAM_API_KEY || "";
const CUSTOM_UPSTREAM_EXTRA_HEADERS = safeJson(env.CUSTOM_UPSTREAM_EXTRA_HEADERS || "{}", {});
const CUSTOM_TIMEOUT_MS = Number(env.CUSTOM_TIMEOUT_MS || 180000);

const CODEX_MODEL_MATCH = (env.CODEX_MODEL_MATCH || "openai-codex/,codex")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CODEX_UPSTREAM_BASE_URL = env.CODEX_UPSTREAM_BASE_URL || "https://api.openai.com";
const CODEX_UPSTREAM_CHAT_PATH = env.CODEX_UPSTREAM_CHAT_PATH || "/v1/chat/completions";
const CODEX_REQUIRE_CLIENT_AUTH = String(env.CODEX_REQUIRE_CLIENT_AUTH || "true").toLowerCase() !== "false";
const CODEX_FALLBACK_API_KEY = env.CODEX_FALLBACK_API_KEY || "";
const CODEX_TIMEOUT_MS = Number(env.CODEX_TIMEOUT_MS || 180000);

const FORWARD_SERVICE_TOKEN = env.FORWARD_SERVICE_TOKEN || "";

// ===== OAuth (independent flow for codex branch) =====
const CODEX_OAUTH_ENABLED = String(env.CODEX_OAUTH_ENABLED || "false").toLowerCase() === "true";
const OAUTH_AUTHORIZE_URL = env.CODEX_OAUTH_AUTHORIZE_URL || "";
const OAUTH_TOKEN_URL = env.CODEX_OAUTH_TOKEN_URL || "";
const OAUTH_CLIENT_ID = env.CODEX_OAUTH_CLIENT_ID || "";
const OAUTH_CLIENT_SECRET = env.CODEX_OAUTH_CLIENT_SECRET || ""; // optional for public client
const OAUTH_SCOPE = env.CODEX_OAUTH_SCOPE || "";
const OAUTH_REDIRECT_URI = env.CODEX_OAUTH_REDIRECT_URI || `http://127.0.0.1:${PORT}/oauth/callback`;
const OAUTH_TOKEN_FILE = env.CODEX_OAUTH_TOKEN_FILE || path.resolve(process.cwd(), "codex-oauth-token.json");

const oauthStateStore = new Map();
const execFileAsync = promisify(execFile);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        service: "api-forward-service",
        routes: ["/v1/chat/completions", "/oauth/start", "/oauth/callback", "/oauth/complete", "/oauth/status"],
        codexModelMatch: CODEX_MODEL_MATCH,
        codexOAuthEnabled: CODEX_OAUTH_ENABLED,
      });
    }

    // OAuth endpoints
    if (url.pathname === "/oauth/start" && req.method === "GET") {
      if (!checkServiceToken(req)) return json(res, 401, { ok: false, error: "invalid forward service token" });
      return handleOauthStart(req, res);
    }
    if (url.pathname === "/oauth/callback" && req.method === "GET") {
      return handleOauthCallback(req, res, url);
    }
    if (url.pathname === "/oauth/status" && req.method === "GET") {
      if (!checkServiceToken(req)) return json(res, 401, { ok: false, error: "invalid forward service token" });
      return handleOauthStatus(res);
    }
    if (url.pathname === "/oauth/complete" && req.method === "POST") {
      if (!checkServiceToken(req)) return json(res, 401, { ok: false, error: "invalid forward service token" });
      return handleOauthComplete(req, res);
    }

    if (req.method !== "POST") return text(res, 405, "Method Not Allowed");
    if (!checkServiceToken(req)) return json(res, 401, { ok: false, error: "invalid forward service token" });
    if (url.pathname !== "/v1/chat/completions") return text(res, 404, "Not Found");

    const bodyRaw = await readBody(req);
    const parsed = safeJson(bodyRaw.toString("utf8"), {});
    const model = String(parsed?.model || "").trim();
    const useCodex = matchCodexModel(model);

    if (useCodex) {
      if (CODEX_OAUTH_ENABLED) {
        return handleCodexChatCompletions({ req, res, parsed });
      }
      return forward({
        req,
        res,
        bodyRaw,
        upstreamBase: CODEX_UPSTREAM_BASE_URL,
        upstreamPath: CODEX_UPSTREAM_CHAT_PATH,
        timeoutMs: CODEX_TIMEOUT_MS,
        fixedApiKey: CODEX_FALLBACK_API_KEY,
        passClientAuth: true,
        requireClientAuth: CODEX_REQUIRE_CLIENT_AUTH,
      });
    }

    return forward({
      req,
      res,
      bodyRaw,
      upstreamBase: CUSTOM_UPSTREAM_BASE_URL,
      upstreamPath: CUSTOM_UPSTREAM_CHAT_PATH,
      timeoutMs: CUSTOM_TIMEOUT_MS,
      fixedApiKey: CUSTOM_UPSTREAM_API_KEY,
      passClientAuth: false,
      extraHeaders: CUSTOM_UPSTREAM_EXTRA_HEADERS,
    });
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err?.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[api-forward-service] listening on http://${HOST}:${PORT}`);
});

async function forward({
  req,
  res,
  bodyRaw,
  upstreamBase,
  upstreamPath,
  timeoutMs,
  fixedApiKey = "",
  passClientAuth = false,
  requireClientAuth = false,
  extraHeaders = {},
  forcedAuthorization = "",
}) {
  if (!upstreamBase) return json(res, 500, { ok: false, error: "upstream base url not configured" });

  const upstreamUrl = buildUpstreamUrl(upstreamBase, upstreamPath);
  const headers = {
    "content-type": req.headers["content-type"] || "application/json",
    accept: req.headers.accept || "application/json",
    ...normalizeHeaders(extraHeaders),
  };

  const clientAuth = req.headers.authorization;
  if (forcedAuthorization) {
    headers.authorization = forcedAuthorization;
  } else {
    if (passClientAuth && clientAuth) headers.authorization = clientAuth;
    if ((!passClientAuth || !clientAuth) && fixedApiKey) headers.authorization = `Bearer ${fixedApiKey}`;
    if (requireClientAuth && !clientAuth) return json(res, 401, { ok: false, error: "missing client Authorization header" });
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1000, Number(timeoutMs || 180000)));

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstreamUrl, { method: "POST", headers, body: bodyRaw, signal: ac.signal });
  } catch (err) {
    clearTimeout(timer);
    return json(res, 502, { ok: false, error: `upstream request failed: ${String(err?.message || err)}` });
  }
  clearTimeout(timer);

  res.statusCode = upstreamResp.status;
  copyHeaders(upstreamResp, res);

  if (!upstreamResp.body) return res.end();
  const reader = upstreamResp.body.getReader();
  const pump = async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
    res.end();
  };
  pump().catch((err) => {
    if (!res.headersSent) json(res, 502, { ok: false, error: `upstream stream failed: ${String(err?.message || err)}` });
    else res.end();
  });
}

function matchCodexModel(model) {
  if (!model) return false;
  const lower = model.toLowerCase();
  return CODEX_MODEL_MATCH.some((m) => lower.includes(m.toLowerCase()));
}

async function handleCodexChatCompletions({ req, res, parsed }) {
  const oauthBearer = await getCodexOauthBearer();
  const accessToken = String(oauthBearer).replace(/^Bearer\s+/i, "").trim();
  const accountId = extractAccountId(accessToken);

  const upstreamUrl = buildUpstreamUrl(CODEX_UPSTREAM_BASE_URL, CODEX_UPSTREAM_CHAT_PATH || "/codex/responses");
  const payload = buildCodexResponsesPayload(parsed);

  const timeoutMs = Math.max(1000, Number(CODEX_TIMEOUT_MS || 180000));
  const payloadStr = JSON.stringify(payload);

  let raw = "";
  try {
    const { stdout, stderr } = await execFileAsync(
      "curl",
      [
        "-sS",
        "-X",
        "POST",
        String(upstreamUrl),
        "-H",
        `authorization: Bearer ${accessToken}`,
        "-H",
        `chatgpt-account-id: ${accountId}`,
        "-H",
        "openai-beta: responses=experimental",
        "-H",
        "originator: pi",
        "-H",
        "accept: text/event-stream",
        "-H",
        "content-type: application/json",
        "--data",
        payloadStr,
      ],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
    );
    raw = String(stdout || "");
    if (stderr) {
      // curl may write progress/errors to stderr even with -sS
      // ignore unless stdout is empty
      if (!raw.trim()) return json(res, 502, { ok: false, error: String(stderr).trim() });
    }
  } catch (err) {
    return json(res, 502, { ok: false, error: `codex curl failed: ${String(err?.message || err)}` });
  }

  if (/cf_chl_opt|<html/i.test(raw)) {
    return json(res, 502, {
      ok: false,
      error: "codex upstream returned anti-bot/login page",
      rawPreview: raw.slice(0, 240),
      debug: { accountId, tokenPrefix: accessToken.slice(0, 12), tokenLen: accessToken.length },
    });
  }

  const parsedSse = parseCodexSse(raw);
  if (!parsedSse.text && !parsedSse.response) {
    const data = safeJson(raw, null);
    if (data?.error) return json(res, 502, data);
    return json(res, 502, { ok: false, error: "codex upstream returned empty stream", rawPreview: raw.slice(0, 240) });
  }

  const out = mapCodexResponsesToChatCompletion(parsedSse.response || { output_text: parsedSse.text }, parsed?.model, parsedSse.text);
  return json(res, 200, out);
}

function buildCodexResponsesPayload(parsed) {
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const systemTexts = [];
  const input = [];

  for (const m of messages) {
    const role = String(m?.role || "user");
    const text = extractMessageText(m?.content);
    if (!text) continue;
    if (role === "system") {
      systemTexts.push(text);
      continue;
    }
    input.push({
      role: role === "assistant" ? "assistant" : "user",
      content: [{ type: "input_text", text }],
    });
  }

  const rawModel = String(parsed?.model || "gpt-5.3-codex");
  const model = rawModel.includes("/") ? rawModel.split("/").pop() : rawModel;

  const body = {
    model,
    store: false,
    stream: true,
    instructions: systemTexts.join("\n\n") || "You are Codex.",
    input,
    text: { verbosity: "medium" },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
  return body;
}

function mapCodexResponsesToChatCompletion(data, reqModel, textOverride = "") {
  const content = textOverride || extractCodexOutputText(data) || "";
  const usage = data?.usage || {};
  const prompt = Number(usage?.input_tokens || 0);
  const completion = Number(usage?.output_tokens || 0);
  return {
    id: data?.id || `chatcmpl_${randomString(12)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: reqModel || data?.model || "openai-codex/gpt-5.3-codex",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
}

function extractCodexOutputText(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text;
  const output = Array.isArray(data.output) ? data.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (typeof c?.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n").trim();
}

function parseCodexSse(raw) {
  const textParts = [];
  let completed = null;
  const chunks = String(raw || "").split(/\r?\n\r?\n/);
  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    if (lines.length === 0) continue;
    const dataStr = lines.map((l) => l.slice(5).trim()).join("\n");
    if (!dataStr || dataStr === "[DONE]") continue;
    const evt = safeJson(dataStr, null);
    if (!evt) continue;
    if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") {
      textParts.push(evt.delta);
      continue;
    }
    if (evt.type === "response.output_text.done" && typeof evt.text === "string" && textParts.length === 0) {
      textParts.push(evt.text);
      continue;
    }
    if (evt.type === "response.completed" && evt.response) {
      completed = evt.response;
    }
  }
  return {
    text: textParts.join(""),
    response: completed,
  };
}

function extractMessageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (typeof p === "string") return p;
      if (p?.type === "text" && typeof p?.text === "string") return p.text;
      return "";
    })
    .join("\n")
    .trim();
}

function extractAccountId(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) throw new Error("invalid token");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (!accountId) throw new Error("account id missing");
    return String(accountId);
  } catch {
    throw new Error("failed to extract account id from oauth token");
  }
}

async function handleOauthStart(req, res) {
  if (!CODEX_OAUTH_ENABLED) return json(res, 400, { ok: false, error: "CODEX_OAUTH_ENABLED=false" });
  if (!OAUTH_AUTHORIZE_URL || !OAUTH_TOKEN_URL || !OAUTH_CLIENT_ID) {
    return json(res, 500, { ok: false, error: "oauth env not configured" });
  }

  const state = randomString(24);
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  oauthStateStore.set(state, { verifier, createdAt: Date.now() });

  const redirectUri = buildRedirectUri(req);
  const authUrl = new URL(OAUTH_AUTHORIZE_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", OAUTH_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  if (OAUTH_SCOPE) authUrl.searchParams.set("scope", OAUTH_SCOPE);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  // Match Codex CLI OAuth hints for better compatibility
  authUrl.searchParams.set("id_token_add_organizations", "true");
  authUrl.searchParams.set("codex_cli_simplified_flow", "true");
  authUrl.searchParams.set("originator", "pi");

  return json(res, 200, {
    ok: true,
    authorizeUrl: authUrl.toString(),
    redirectUri,
    note: "Open authorizeUrl in browser. If callback fails, copy the full redirected URL and POST it to /oauth/complete",
  });
}

async function handleOauthCallback(req, res, url) {
  try {
    const code = String(url.searchParams.get("code") || "");
    const state = String(url.searchParams.get("state") || "");
    const error = String(url.searchParams.get("error") || "");
    if (error) return text(res, 400, `OAuth failed: ${error}`);
    if (!code || !state) return text(res, 400, "Missing code/state");

    const st = oauthStateStore.get(state);
    if (!st) return text(res, 400, "Invalid or expired state");
    oauthStateStore.delete(state);

    const redirectUri = buildRedirectUri(req);
    const token = await exchangeCodeForToken({ code, verifier: st.verifier, redirectUri });
    persistToken(token);

    return text(res, 200, "OAuth success. Token saved. You can close this page.");
  } catch (err) {
    return text(res, 500, `OAuth callback failed: ${String(err?.message || err)}`);
  }
}

async function handleOauthComplete(req, res) {
  try {
    const raw = await readBody(req);
    const parsed = safeJson(raw.toString("utf8"), {});
    const redirectUrl = String(parsed?.redirectUrl || parsed?.redirect_url || "").trim();
    const code = String(parsed?.code || "").trim();
    const state = String(parsed?.state || "").trim();

    const fromUrl = parseAuthorizationInput(redirectUrl);
    const finalCode = code || fromUrl.code || "";
    const finalState = state || fromUrl.state || "";
    if (!finalCode || !finalState) {
      return json(res, 400, { ok: false, error: "missing code/state (provide redirectUrl or code+state)" });
    }

    const st = oauthStateStore.get(finalState);
    if (!st) return json(res, 400, { ok: false, error: "invalid or expired state" });
    oauthStateStore.delete(finalState);

    const redirectUri = OAUTH_REDIRECT_URI;
    const token = await exchangeCodeForToken({ code: finalCode, verifier: st.verifier, redirectUri });
    persistToken(token);
    return json(res, 200, { ok: true, authorized: true });
  } catch (err) {
    return json(res, 500, { ok: false, error: `oauth complete failed: ${String(err?.message || err)}` });
  }
}

function handleOauthStatus(res) {
  const token = readToken();
  if (!token) return json(res, 200, { ok: true, authorized: false });
  const now = Date.now();
  return json(res, 200, {
    ok: true,
    authorized: true,
    expiresAt: token.expires_at || null,
    expired: token.expires_at ? token.expires_at <= now : false,
    hasRefreshToken: Boolean(token.refresh_token),
    tokenFile: OAUTH_TOKEN_FILE,
  });
}

async function getCodexOauthBearer() {
  if (!CODEX_OAUTH_ENABLED) return "";

  let token = readToken();
  if (!token?.access_token) {
    throw new Error("codex oauth token missing: visit /oauth/start to authorize");
  }

  const now = Date.now();
  const skewMs = 60_000;
  if (token.expires_at && now + skewMs >= token.expires_at) {
    token = await refreshAccessToken(token);
    persistToken(token);
  }

  if (!token?.access_token) throw new Error("codex oauth token invalid");
  return `Bearer ${token.access_token}`;
}

async function exchangeCodeForToken({ code, verifier, redirectUri }) {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("client_id", OAUTH_CLIENT_ID);
  body.set("redirect_uri", redirectUri);
  body.set("code_verifier", verifier);
  if (OAUTH_CLIENT_SECRET) body.set("client_secret", OAUTH_CLIENT_SECRET);

  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const data = safeJson(await resp.text(), {});
  if (!resp.ok) throw new Error(`token exchange failed: ${resp.status} ${JSON.stringify(data)}`);
  return withExpiry(data);
}

async function refreshAccessToken(token) {
  if (!token?.refresh_token) throw new Error("token expired and refresh_token missing");
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", token.refresh_token);
  body.set("client_id", OAUTH_CLIENT_ID);
  if (OAUTH_CLIENT_SECRET) body.set("client_secret", OAUTH_CLIENT_SECRET);

  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const data = safeJson(await resp.text(), {});
  if (!resp.ok) throw new Error(`token refresh failed: ${resp.status} ${JSON.stringify(data)}`);

  const merged = {
    ...token,
    ...data,
    refresh_token: data.refresh_token || token.refresh_token,
  };
  return withExpiry(merged);
}

function withExpiry(token) {
  const now = Date.now();
  const expiresIn = Number(token.expires_in || 0);
  if (expiresIn > 0) token.expires_at = now + expiresIn * 1000;
  return token;
}

function persistToken(token) {
  const dir = path.dirname(OAUTH_TOKEN_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OAUTH_TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 });
}

function readToken() {
  try {
    const raw = fs.readFileSync(OAUTH_TOKEN_FILE, "utf8");
    return safeJson(raw, null);
  } catch {
    return null;
  }
}

function buildRedirectUri(req) {
  if (OAUTH_REDIRECT_URI) return OAUTH_REDIRECT_URI;
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const proto = String(req.headers["x-forwarded-proto"] || "http");
  return `${proto}://${host}/oauth/callback`;
}

function copyHeaders(upstreamResp, res) {
  const passthrough = ["content-type", "cache-control", "x-request-id", "openai-processing-ms"];
  for (const h of passthrough) {
    const v = upstreamResp.headers.get(h);
    if (v) res.setHeader(h, v);
  }
}

function ensureSlash(base) {
  return base.endsWith("/") ? base : `${base}/`;
}

function buildUpstreamUrl(base, pathPart) {
  const baseUrl = new URL(ensureSlash(base));
  const rawPath = String(pathPart || "").trim();
  if (!rawPath) return baseUrl;
  // If path is absolute-url, honor it directly.
  if (/^https?:\/\//i.test(rawPath)) return new URL(rawPath);

  // Preserve base pathname for relative API segments like backend-api + /codex/responses.
  const normalized = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/${normalized}`.replace(/\/+/g, "/");
  return baseUrl;
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizeHeaders(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null) continue;
    out[String(k).toLowerCase()] = String(v);
  }
  return out;
}

function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function parseAuthorizationInput(input) {
  const value = String(input || "").trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") || undefined,
      state: url.searchParams.get("state") || undefined,
    };
  } catch {
    return {};
  }
}

function randomString(bytes = 16) {
  return base64url(crypto.randomBytes(bytes));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function text(res, status, msg) {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(msg);
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function checkServiceToken(req) {
  if (!FORWARD_SERVICE_TOKEN) return true;

  const xForwardToken = String(req.headers["x-forward-token"] || "").trim();
  const authRaw = String(req.headers["authorization"] || "").trim();
  const bearer = authRaw.toLowerCase().startsWith("bearer ") ? authRaw.slice(7).trim() : "";

  // 标准写法优先：Authorization: Bearer <service-token>
  if (bearer && bearer === FORWARD_SERVICE_TOKEN) return true;

  // 兼容旧写法，便于平滑迁移
  if (xForwardToken && xForwardToken === FORWARD_SERVICE_TOKEN) return true;

  return false;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
