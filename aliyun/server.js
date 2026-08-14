/* 恋人 FC 后端：chat 代理 + OSS 版多端同步。零依赖，Node 18+（custom runtime）。 */
"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = 9000;
const APP_TOKEN = process.env.APP_TOKEN || "bd6829b897af9f18895b5fe5";
const MODEL_KEY = process.env.MODEL_KEY || "";
const UPSTREAM = (process.env.UPSTREAM || "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || "";
const OPENROUTER_UP = "https://openrouter.ai/api/v1";
const OSS_AK_ID = process.env.OSS_AK_ID || "";
const OSS_AK_SECRET = process.env.OSS_AK_SECRET || "";
const OSS_BUCKET = process.env.OSS_BUCKET || "lover-sync-wrz0804";
const OSS_HOST = OSS_BUCKET + ".oss-cn-beijing.aliyuncs.com";
const DASHSCOPE_KEY = process.env.DASHSCOPE_KEY || "";

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
/* 登录功能上线前的旧数据走的是扁平 key（lover.profiles / lover.msg.p1 …，不带账号段）。
   它们曾被老版本页面当作"无主数据"拉进任意新账号，造成串号。
   这里对这类 key 一律禁读禁写：老缓存页面再取也只能拿到 null，新账号从此彻底独立。
   带账号的命名空间 key 形如 lover.{16位hex}.xxx，账号段是纯 hex，不会命中下面的词表。 */
function isLegacyFlatKey(k) {
  return /^lover\.(api|profiles|lastActive|settings|messages|memorySummary|msg\.|mem\.)/.test(k);
}

/* ---------- 静态文件（前端由 FC 直接吐出；OSS 默认域名会强制下载网页） ---------- */
const STATIC_FILES = {
  "/": { file: "index.html", type: "text/html" },
  "/index.html": { file: "index.html", type: "text/html" },
  "/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json; charset=utf-8" },
  "/icon.png": { file: "icon.png", type: "image/png" },
};
function serveStatic(res, entry) {
  let buf;
  try { buf = fs.readFileSync(path.join(__dirname, entry.file)); }
  catch (e) { return json(res, 404, { error: "not found" }); }
  cors(res);
  res.setHeader("Content-Disposition", "inline");
  res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-cache" });
  return res.end(buf);
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(200); return res.end(); }

  const url = (req.url || "/").split("?")[0];

  if (req.method === "GET") {
    if (url === "/health") return json(res, 200, { ok: true, service: "lover-api" });
    if (url === "/models") {
      if (req.headers["x-app-token"] !== APP_TOKEN) return json(res, 401, { error: "token 校验失败" });
      if (!MODEL_KEY) return json(res, 500, { error: "服务端未配置 MODEL_KEY" });
      let r;
      try {
        r = await fetch(UPSTREAM + "/models", { headers: { "Authorization": "Bearer " + MODEL_KEY } });
      } catch (e) { return json(res, 502, { error: "模型服务连接失败" }); }
      const text = await r.text();
      cors(res);
      res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(text);
    }
    const entry = STATIC_FILES[url];
    if (entry) return serveStatic(res, entry);
    return json(res, 404, { error: "not found" });
  }

  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: "请求体不是合法 JSON" }); }

  if (!tokenOk(req, body)) return json(res, 401, { error: "token 校验失败" });

  /* --- chat 代理 --- */
  if (req.method === "POST" && url === "/chat") {
    const model = body.model || "qwen3.8-max";
    /* OpenRouter 风格模型 ID（含 /）走 OpenRouter，用服务端 key，前端无需配置 */
    const useOR = model.indexOf("/") !== -1;
    if (useOR && !OPENROUTER_KEY) return json(res, 500, { error: "服务端未配置 OPENROUTER_KEY" });
    if (!useOR && !MODEL_KEY) return json(res, 500, { error: "服务端未配置 MODEL_KEY" });
    const payload = {
      model: model,
      messages: body.messages || [],
      stream: !!body.stream,
      temperature: 0.85,
      top_p: 0.9,
      frequency_penalty: 0.7, // 抑制车轱辘话：已出现过的词再出现要扣分
      presence_penalty: 0.6,  // 鼓励往前推进，别原地打转
      max_tokens: 2000, // 放开长度：走心回复不被截断，仍留安全阀
    };
    /* 上游调用：网络错误 / 429 / 5xx 自动重试最多 3 次（OpenRouter 等外部线路偶发抖动，用户无感） */
    const upUrl = (useOR ? OPENROUTER_UP : UPSTREAM) + "/chat/completions";
    const upHeaders = { "Content-Type": "application/json", "Authorization": "Bearer " + (useOR ? OPENROUTER_KEY : MODEL_KEY) };
    const upBody = JSON.stringify(payload);
    let upstream = null;
    let lastErr = "";
    for (let attempt = 1; attempt <= 3 && !upstream; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 45000); // 单次建连上限，卡住就换一次重试
      try {
        const r = await fetch(upUrl, { method: "POST", headers: upHeaders, body: upBody, signal: ac.signal });
        clearTimeout(timer);
        if (r.status === 429 || r.status >= 500) {
          const t = await r.text().catch(() => "");
          lastErr = "上游返回 " + r.status + (t ? "：" + t.slice(0, 200) : "");
          if (attempt < 3) await new Promise((rr) => setTimeout(rr, 700 * attempt));
          continue;
        }
        upstream = r;
      } catch (e) {
        clearTimeout(timer);
        lastErr = "上游连接异常：" + String((e && e.message) || e);
        if (attempt < 3) await new Promise((rr) => setTimeout(rr, 700 * attempt));
      }
    }
    if (!upstream) return json(res, 502, { error: "模型服务暂时不稳定，已自动重试过，稍后再发一次试试", detail: lastErr });
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
    if (!upstream.ok) {
      let friendly = null;
      try {
        const j = JSON.parse(text);
        const m = String((j.error && (typeof j.error === "string" ? j.error : j.error.message)) || "");
        if (/not available in your region/i.test(m)) friendly = "这个模型对服务器所在地区有访问限制，用不了。请选收藏列表里的模型，或 deepseek/、qwen/、moonshotai/ 开头的模型";
        else if (/no endpoints found/i.test(m)) friendly = "没有这个模型，检查下模型名（格式一般是 厂商/模型名）";
        else if (upstream.status === 401) friendly = "上游 API 拒绝了请求（Key 无效或额度用完）：" + m.slice(0, 100);
        else if (upstream.status === 429) friendly = "上游限流了，稍等一会儿再发";
      } catch (e) { /* 非 JSON 错误原样透传 */ }
      if (friendly) return json(res, upstream.status === 429 ? 429 : 400, { error: friendly });
    }
    cors(res);
    res.writeHead(upstream.status, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(text);
  }

  /* --- 真人音色 TTS（CosyVoice 代理） --- */
  if (req.method === "POST" && url === "/tts") {
    if (!DASHSCOPE_KEY) return json(res, 503, { error: "服务端未配置 DASHSCOPE_KEY" });
    const text = String(body.text || "").trim().slice(0, 500);
    if (!text) return json(res, 400, { error: "text 不能为空" });
    const voice = String(body.voice || "longwan").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
    let r;
    try {
      r = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/audio/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + DASHSCOPE_KEY },
        body: JSON.stringify({ model: "cosyvoice-v1", voice: voice, input: text }),
      });
    } catch (e) {
      return json(res, 502, { error: "TTS 服务连接失败" });
    }
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return json(res, 502, { error: "TTS 失败 " + r.status + " " + t.slice(0, 150) });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    cors(res);
    res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": buf.length });
    return res.end(buf);
  }

  /* --- 多端同步 --- */
  if (req.method === "POST" && url === "/sync") {
    const action = body.action;
    const key = safeKey(body.key);
    if (!key) return json(res, 400, { error: "缺少 key" });
    if (isLegacyFlatKey(key)) {
      if (action === "get") return json(res, 200, null); // 旧扁平数据一律视为无，杜绝新账号继承
      if (action === "set" || action === "del") return json(res, 403, { error: "旧版扁平 key 已冻结" });
    }
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
    if (action === "del") {
      let r;
      try { r = await ossRequest("DELETE", "sync/" + key + ".json"); }
      catch (e) { return json(res, 502, { error: "同步服务连接失败" }); }
      if (!r.ok && r.status !== 404) return json(res, 502, { error: "同步删除失败 " + r.status });
      return json(res, 200, { success: true });
    }
    return json(res, 400, { error: "无效的操作" });
  }

  return json(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => console.log("lover-api listening on " + PORT));
