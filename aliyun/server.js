/* 恋人 FC 后端：chat 代理 + OSS 版多端同步。零依赖，Node 18+（custom runtime）。 */
"use strict";
const http = require("http");
const crypto = require("crypto");

const PORT = 9000;
const APP_TOKEN = process.env.APP_TOKEN || "bd6829b897af9f18895b5fe5";
const MODEL_KEY = process.env.MODEL_KEY || "";
const UPSTREAM = (process.env.UPSTREAM || "https://ws-92p7q0447oxhg6qo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
const OSS_AK_ID = process.env.OSS_AK_ID || "";
const OSS_AK_SECRET = process.env.OSS_AK_SECRET || "";
const OSS_BUCKET = process.env.OSS_BUCKET || "lover-sync-wrz0804";
const OSS_HOST = OSS_BUCKET + ".oss-cn-beijing.aliyuncs.com";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-App-Token");
}
function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}
function tokenOk(req, body) {
  return req.headers["x-app-token"] === APP_TOKEN || (body && body.token === APP_TOKEN);
}

/* ---------- OSS V1 签名 ---------- */
function ossRequest(method, objectKey, bodyBuf) {
  const date = new Date().toUTCString();
  const contentType = bodyBuf ? "application/json" : "";
  const md5 = bodyBuf ? crypto.createHash("md5").update(bodyBuf).digest("base64") : "";
  const resource = "/" + OSS_BUCKET + "/" + objectKey;
  const stringToSign = [method, md5, contentType, date, resource].join("\n");
  const sig = crypto.createHmac("sha1", OSS_AK_SECRET).update(stringToSign).digest("base64");
  const headers = {
    "Date": date,
    "Authorization": "OSS " + OSS_AK_ID + ":" + sig,
  };
  if (md5) headers["Content-MD5"] = md5;
  if (contentType) headers["Content-Type"] = contentType;
  return fetch("https://" + OSS_HOST + "/" + objectKey, { method, headers, body: bodyBuf || undefined });
}
function safeKey(k) {
  return String(k || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(200); return res.end(); }

  const url = (req.url || "/").split("?")[0];

  if (req.method === "GET" && url === "/") return json(res, 200, { ok: true, service: "lover-api" });

  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: "请求体不是合法 JSON" }); }

  if (!tokenOk(req, body)) return json(res, 401, { error: "token 校验失败" });

  /* --- chat 代理 --- */
  if (req.method === "POST" && url === "/chat") {
    if (!MODEL_KEY) return json(res, 500, { error: "服务端未配置 MODEL_KEY" });
    const payload = {
      model: body.model || "qwen3.8-max",
      messages: body.messages || [],
      stream: !!body.stream,
      temperature: 0.85,
      top_p: 0.9,
    };
    let upstream;
    try {
      upstream = await fetch(UPSTREAM + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + MODEL_KEY },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return json(res, 502, { error: "模型服务连接失败" });
    }
    if (payload.stream && (upstream.headers.get("content-type") || "").includes("event-stream") && upstream.ok) {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } catch (e) { /* 客户端断开等 */ }
      return res.end();
    }
    const text = await upstream.text();
    cors(res);
    res.writeHead(upstream.status, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(text);
  }

  /* --- 多端同步 --- */
  if (req.method === "POST" && url === "/sync") {
    const action = body.action;
    const key = safeKey(body.key);
    if (!key) return json(res, 400, { error: "缺少 key" });
    if (action === "get") {
      let r;
      try { r = await ossRequest("GET", "sync/" + key + ".json"); }
      catch (e) { return json(res, 502, { error: "同步服务连接失败" }); }
      if (r.status === 404) return json(res, 200, null);
      if (!r.ok) return json(res, 502, { error: "同步读取失败 " + r.status });
      const val = await r.json().catch(() => null);
      return json(res, 200, val);
    }
    if (action === "set") {
      const buf = Buffer.from(JSON.stringify(body.data === undefined ? null : body.data), "utf8");
      let r;
      try { r = await ossRequest("PUT", "sync/" + key + ".json", buf); }
      catch (e) { return json(res, 502, { error: "同步服务连接失败" }); }
      if (!r.ok) { const t = await r.text().catch(() => ""); return json(res, 502, { error: "同步写入失败 " + r.status + " " + t.slice(0, 200) }); }
      return json(res, 200, { success: true });
    }
    return json(res, 400, { error: "无效的操作" });
  }

  return json(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => console.log("lover-api listening on " + PORT));
