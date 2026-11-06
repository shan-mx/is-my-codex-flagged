#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import process from "node:process";
import { pathToFileURL } from "node:url";

const VERSION = "0.1.0";
const AUTH = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PROBE_URL = `${RESOURCE}/responses`;
const MODEL = "gpt-6-luna";
const TIMEOUT_MS = 45_000;
const MAX_BODY = 64 * 1024;
const FLAG = "subscription_sharing_user_not_eligible";

function authorizeUrl(state, challenge, hostId, nonce) {
  const query = new URLSearchParams({
    client_id: DYNAMIC_CLIENT_ID,
    agent_name_hint: "is-my-codex-flagged",
    ext_agent_host_id: hostId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    nonce,
  });
  return `${AUTH}/api/accounts/authorize?${query}`;
}

function startCallbackServer(expectedState) {
  let settle;
  const result = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  result.catch(() => {});

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/auth/callback") {
      response.writeHead(404).end();
      return;
    }

    const code = url.searchParams.get("code");
    const clientId = url.searchParams.get("client_id");
    const error = url.searchParams.get("error");
    const ok = Boolean(code) && Boolean(clientId) && !error && url.searchParams.get("state") === expectedState;

    response.writeHead(ok ? 200 : 400, { "content-type": "text/plain; charset=utf-8" });
    response.end(ok ? "登录成功，可以关闭此页面了。" : "登录失败，请回到终端重试。");

    if (ok) settle.resolve({ code, clientId });
    else settle.reject(new Error(error ? `授权失败：${url.searchParams.get("error_description") ?? error}` : "回调校验失败"));
  });

  const timer = setTimeout(() => settle.reject(new Error("登录超时")), 5 * 60_000);
  timer.unref?.();

  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error.code === "EADDRINUSE" ? new Error("端口 1455 被占用，稍后再试") : error);
    });
    server.listen(1455, "127.0.0.1", () =>
      resolve({
        result,
        close() {
          clearTimeout(timer);
          server.close();
        },
      }),
    );
  });
}

function openBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {}
}

async function login() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const callback = await startCallbackServer(state);
  const url = authorizeUrl(state, challenge, `urn:uuid:${randomUUID()}`, nonce);

  console.log(`在浏览器中完成登录：\n  ${url}\n`);
  openBrowser(url);

  try {
    const { code, clientId } = await callback.result;
    const response = await fetch(`${AUTH}/api/accounts/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`换取 token 失败（HTTP ${response.status}）：${text.slice(0, 300)}`);
    const token = JSON.parse(text);
    if (!token.access_token) throw new Error("token 响应里没有 access_token");
    return token.access_token;
  } finally {
    callback.close();
  }
}

export async function probe({ accessToken, model }) {
  const started = Date.now();
  try {
    const response = await fetch(PROBE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "user-agent": `is-my-codex-flagged/${VERSION}`,
      },
      body: JSON.stringify({
        model,
        stream: true,
        store: false,
        input: [{ role: "user", content: [{ type: "input_text", text: "Reply with the single word: ok" }] }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const body = (await response.text()).slice(0, MAX_BODY);
    return { status: response.status, body, durationMs: Date.now() - started };
  } catch (error) {
    const message = error?.name === "TimeoutError" ? "请求超时" : (error?.message ?? String(error));
    return { status: 0, error: message, durationMs: Date.now() - started };
  }
}

function extract(text, field) {
  return text.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))?.[1] ?? null;
}

function out(verdict, label, exitCode, code = null, detail = null) {
  return { verdict, label, exitCode, code, detail };
}

export function decide(result) {
  const body = result.body ?? "";
  const code = extract(body, "code");
  const detail = extract(body, "message");

  if (body.includes(FLAG)) return out("banned", "账号已被风控", 1, FLAG, detail);
  if (result.error) return out("error", "检测失败", 2, null, result.error);
  if (result.status >= 200 && result.status < 300 && !/"type"\s*:\s*"response\.failed"/.test(body)) {
    return out("ok", "账号正常", 0);
  }
  return out("error", "检测失败", 2, code, detail);
}

export function report(verdict, result) {
  const icon = verdict.exitCode === 0 ? "✓" : verdict.exitCode === 1 ? "✗" : "!";
  const lines = [`${icon} ${verdict.label}`, `  ${result.status || "无响应"} · ${(result.durationMs / 1000).toFixed(1)}s`];
  if (verdict.code) lines.push(`  ${verdict.code}`);
  if (verdict.detail) lines.push(`  ${verdict.detail}`);

  console.log(lines.join("\n"));
  if (verdict.verdict === "banned") {
    console.log("\n建议：网页端启用高级账号保护 → 登出所有设备 → 静置约 24h 后再测。");
  }
}

export async function main() {
  const accessToken = await login();
  const result = await probe({ accessToken, model: MODEL });
  const verdict = decide(result);
  report(verdict, result);
  return verdict.exitCode;
}

// npm and npx run the bin through a symlink, so compare the resolved path.
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`✗ ${error.message}`);
      process.exitCode = 2;
    });
}
