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
function ossRequest(method, objectKey, bodyBuf, contentTypeOverride) {
  const date = new Date().toUTCString();
  const contentType = bodyBuf ? (contentTypeOverride || "application/json") : "";
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

/* ---------- 生图双通道：安全场景走万相（订阅自带），亲密场景走可配置无审查线路，互为备份 ---------- */
const IMG2_BASE = (process.env.IMG2_BASE || "").replace(/\/+$/, "");
const IMG2_KEY = process.env.IMG2_KEY || "";
const IMG2_MODEL = process.env.IMG2_MODEL || "";
async function genWan(prompt) {
  let r;
  try {
    r = await fetch(UPSTREAM.replace(/\/compatible-mode\/v1$/, "") + "/api/v1/services/aigc/multimodal-generation/generation", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + MODEL_KEY },
      body: JSON.stringify({ model: "wan2.7-image", input: { messages: [{ role: "user", content: [{ text: prompt }] }] }, parameters: { size: "768*768", n: 1 } }),
    });
  } catch (e) { return null; }
  if (!r.ok) return null;
  let imgUrl = "";
  try { imgUrl = (JSON.parse(await r.text())).output.choices[0].message.content[0].image; } catch (e) { return null; }
  if (!imgUrl) return null;
  try {
    const ir = await fetch(imgUrl.replace(/^http:\/\//, "https://"));
    if (!ir.ok) return null;
    return Buffer.from(await ir.arrayBuffer());
  } catch (e) { return null; }
}
async function genImg2(prompt) {
  if (!IMG2_BASE || !IMG2_KEY) return null;
  let r;
  try {
    r = await fetch(IMG2_BASE + "/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + IMG2_KEY },
      body: JSON.stringify({ model: IMG2_MODEL, prompt: prompt, size: "768x768", n: 1 }),
    });
  } catch (e) { return null; }
  if (!r.ok) return null;
  try {
    const j = JSON.parse(await r.text());
    const it = j.data && j.data[0];
    if (it && it.b64_json) return Buffer.from(it.b64_json, "base64");
    if (it && it.url) { const ir = await fetch(it.url.replace(/^http:\/\//, "https://")); if (ir.ok) return Buffer.from(await ir.arrayBuffer()); }
  } catch (e) { /* 解析失败走备份 */ }
  return null;
}
function sanitizePrompt(p) {
  return String(p).replace(/(裸|赤裸|私处|下体|阴茎|阴道|乳头|乳晕|臀|穴|做爱|性交|插入|射|喘息|缠绵|云雨|高潮)/g, "").replace(/亲密[^，。；\n]*/g, "拥抱");
}
async function genImage(route, prompt) {
  if (route === "nsfw") return (await genImg2(prompt)) || (await genWan(sanitizePrompt(prompt)));
  return (await genWan(prompt)) || (await genImg2(prompt)) || (await genWan(sanitizePrompt(prompt)));
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
    if (url === "/avatar") {
      let q; try { q = new URL(req.url, "http://x").searchParams; } catch (e) { return json(res, 400, { error: "bad url" }); }
      if (q.get("token") !== APP_TOKEN) return json(res, 401, { error: "token 校验失败" });
      const key = safeKey(q.get("key"));
      if (!key || !/^lover\.[0-9a-f]{16}\.(avatar|pic)\./.test(key)) return json(res, 400, { error: "非法 key" });
      let r;
      try { r = await ossRequest("GET", "sync/" + key + ".jpg"); } catch (e) { return json(res, 502, { error: "头像服务连接失败" }); }
      if (!r.ok) return json(res, 404, { error: "头像不存在" });
      const buf = Buffer.from(await r.arrayBuffer());
      cors(res);
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" });
      return res.end(buf);
    }
    const entry = STATIC_FILES[url];
    if (entry) return serveStatic(res, entry);
    return json(res, 404, { error: "not found" });
  }

  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: "请求体不是合法 JSON" }); }

  if (!tokenOk(req, body)) return json(res, 401, { error: "token 校验失败" });

  /* --- 头像上传（base64 -> OSS） --- */
  if (req.method === "POST" && url === "/avatar") {
    const key = safeKey(body.key);
    if (!key || !/^lover\.[0-9a-f]{16}\.(avatar|pic)\./.test(key)) return json(res, 400, { error: "非法 key" });
    if (body.action === "del") {
      try { await ossRequest("DELETE", "sync/" + key + ".jpg"); } catch (e) { return json(res, 502, { error: "头像服务连接失败" }); }
      return json(res, 200, { success: true });
    }
    const raw = String(body.data || "").replace(/^data:[^;]+;base64,/, "");
    const buf = Buffer.from(raw, "base64");
    if (!buf.length || buf.length > 2 * 1024 * 1024) return json(res, 400, { error: "图片大小不合适（2MB 内）" });
    let r;
    try { r = await ossRequest("PUT", "sync/" + key + ".jpg", buf, "image/jpeg"); } catch (e) { return json(res, 502, { error: "头像服务连接失败" }); }
    if (!r.ok) { const t = await r.text().catch(() => ""); return json(res, 502, { error: "头像保存失败 " + r.status + " " + t.slice(0, 150) }); }
    return json(res, 200, { success: true });
  }

  /* --- AI 生图（双通道：route=nsfw 走无审查线路，默认走万相；互为备份） --- */
  if (req.method === "POST" && url === "/genimg") {
    const prompt = String(body.prompt || "").trim().slice(0, 800);
    if (!prompt) return json(res, 400, { error: "prompt 不能为空" });
    const buf = await genImage(body.route === "nsfw" ? "nsfw" : "safe", prompt);
    if (!buf) return json(res, 502, { error: "生图失败：两条线路都不可用或被拦截" });
    cors(res);
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": buf.length });
    return res.end(buf);
  }

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
      enable_thinking: false, // 关掉推理模型的长思考：RP 要快、要直接，思考链只会拖慢并触发超时
    };
    /* 上游调用：429/5xx/网络错误自动重试；OpenRouter 另带兜底链——所选模型不稳时按序自动切换备用模型 */
    const OR_CHAIN = ["thedrummer/cydonia-24b-v4.1", "cognitivecomputations/dolphin-mistral-24b-venice-edition", "sao10k/l3.3-euryale-70b"];
    const modelList = useOR ? [model].concat(OR_CHAIN.filter((m) => m !== model)) : [model];
    const upUrl = (useOR ? OPENROUTER_UP : UPSTREAM) + "/chat/completions";
    const upHeaders = { "Content-Type": "application/json", "Authorization": "Bearer " + (useOR ? OPENROUTER_KEY : MODEL_KEY) };
    let upstream = null;
    let lastErr = "";
    for (let mi = 0; mi < modelList.length && !upstream; mi++) {
      payload.model = modelList[mi];
      const upBody = JSON.stringify(payload);
      const tries = useOR ? 2 : 3;
      for (let attempt = 1; attempt <= tries && !upstream; attempt++) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 75000); // 单次建连上限，卡住就换一次重试
        try {
          const r = await fetch(upUrl, { method: "POST", headers: upHeaders, body: upBody, signal: ac.signal });
          clearTimeout(timer);
          if (r.status === 429 || r.status >= 500) {
            const t = await r.text().catch(() => "");
            lastErr = "上游返回 " + r.status + (t ? "：" + t.slice(0, 200) : "");
            if (attempt < tries) await new Promise((rr) => setTimeout(rr, 600 * attempt));
            continue;
          }
          upstream = r;
        } catch (e) {
          clearTimeout(timer);
          lastErr = "上游连接异常：" + String((e && e.message) || e);
          if (attempt < tries) await new Promise((rr) => setTimeout(rr, 600 * attempt));
        }
      }
    }
    if (!upstream) return json(res, 502, { error: "模型服务暂时不稳定，已自动重试并切换过备用模型，稍后再发一次试试", detail: lastErr });
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

  /* --- 真人音色 TTS（订阅自带 Qwen-Audio-TTS 代理） --- */
  if (req.method === "POST" && url === "/tts") {
    const text = String(body.text || "").trim().slice(0, 500);
    if (!text) return json(res, 400, { error: "text 不能为空" });
    const voice = String(body.voice || "longanlingxin").replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 40);
    let r;
    try {
      r = await fetch(UPSTREAM.replace(/\/compatible-mode\/v1$/, "") + "/api/v1/services/audio/tts/SpeechSynthesizer", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + MODEL_KEY },
        body: JSON.stringify({ model: "qwen-audio-3.0-tts-plus", input: { text: text, voice: voice, format: "wav", sample_rate: 24000 } }),
      });
    } catch (e) {
      return json(res, 502, { error: "TTS 服务连接失败" });
    }
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return json(res, 502, { error: "TTS 失败 " + r.status + " " + t.slice(0, 150) });
    }
    let audioUrl = "";
    try { audioUrl = (JSON.parse(await r.text())).output.audio.url; } catch (e) { return json(res, 502, { error: "TTS 返回解析失败" }); }
    if (!audioUrl) return json(res, 502, { error: "TTS 没有返回音频" });
    let ar;
    try { ar = await fetch(audioUrl.replace(/^http:\/\//, "https://")); } catch (e) { return json(res, 502, { error: "音频拉取失败" }); }
    if (!ar.ok) return json(res, 502, { error: "音频拉取失败 " + ar.status });
    const buf = Buffer.from(await ar.arrayBuffer());
    cors(res);
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": buf.length });
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

/* ---------- 端到端实时语音中继：浏览器 <-> FC <-> Qwen-Realtime（零依赖手写 WS） ---------- */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const RT_UP_HOST = UPSTREAM.replace("https://", "").replace(/\/compatible-mode\/v1$/, "");
function wsFrame(opcode, buf, mask) {
  const len = buf.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | opcode;
  if (!mask) return Buffer.concat([head, buf]);
  head[1] |= 0x80;
  const mk = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = buf[i] ^ mk[i % 4];
  return Buffer.concat([head, mk, masked]);
}
function wsParser(onFrame) {
  let buf = Buffer.alloc(0);
  return function (chunk) {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      let mk = null;
      if (masked) { if (buf.length < off + 4) return; mk = buf.slice(off, off + 4); off += 4; }
      if (buf.length < off + len) return;
      let payload = buf.slice(off, off + len);
      if (mk) { const u = Buffer.alloc(len); for (let i = 0; i < len; i++) u[i] = payload[i] ^ mk[i % 4]; payload = u; }
      buf = buf.slice(off + len);
      onFrame(opcode, payload);
    }
  };
}
function rtConnect(handlers) {
  return new Promise((resolve, reject) => {
    const tls = require("tls");
    let handshaken = false, settled = false;
    const sock = tls.connect(443, RT_UP_HOST, { servername: RT_UP_HOST }, () => {
      const key = crypto.randomBytes(16).toString("base64");
      sock.write("GET /api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus HTTP/1.1\r\nHost: " + RT_UP_HOST + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer " + MODEL_KEY + "\r\n\r\n");
    });
    const feed = wsParser((op, payload) => {
      if (op === 0x1 && handlers.onText) handlers.onText(payload.toString());
      else if (op === 0x8 && handlers.onClose) handlers.onClose();
    });
    sock.on("data", (c) => {
      if (!handshaken) {
        const s = c.toString("utf8");
        const idx = s.indexOf("\r\n\r\n");
        if (idx === -1) return;
        if (s.slice(0, 12) !== "HTTP/1.1 101") { if (!settled) { settled = true; reject(new Error("上游 WS 握手被拒")); } sock.destroy(); return; }
        handshaken = true;
        if (!settled) {
          settled = true;
          resolve({
            send: (obj) => { try { sock.write(wsFrame(0x1, Buffer.from(JSON.stringify(obj)), true)); } catch (e) {} },
            close: () => { try { sock.write(wsFrame(0x8, Buffer.alloc(0), true)); sock.end(); } catch (e) {} },
          });
        }
        const rest = c.slice(Buffer.byteLength(s.slice(0, idx + 4), "utf8"));
        if (rest.length) feed(rest);
        return;
      }
      feed(c);
    });
    sock.on("error", () => { if (!settled) { settled = true; reject(new Error("上游 WS 连接失败")); } else if (handlers.onClose) handlers.onClose(); });
    sock.on("close", () => { if (!settled) { settled = true; reject(new Error("上游 WS 关闭")); } else if (handlers.onClose) handlers.onClose(); });
    setTimeout(() => { if (!settled) { settled = true; reject(new Error("上游 WS 超时")); sock.destroy(); } }, 15000);
  });
}
server.on("upgrade", (req, socket) => {
  let q; try { q = new URL(req.url, "http://x").searchParams; } catch (e) { socket.destroy(); return; }
  if ((req.url || "").indexOf("/rt") !== 0 || q.get("token") !== APP_TOKEN) { socket.destroy(); return; }
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + crypto.createHash("sha1").update(key + WS_GUID).digest("base64") + "\r\n\r\n");
  const sendClient = (obj) => { try { socket.write(wsFrame(0x1, Buffer.from(JSON.stringify(obj)), false)); } catch (e) {} };
  let up = null, upReady = false, closed = false;
  const pending = [];
  const voice = (q.get("voice") || "longanlingxin").replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 40);
  const sessionBase = { modalities: ["text", "audio"], voice: voice, input_audio_format: "pcm16", output_audio_format: "pcm16", turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 800 } };
  const sendSession = (h) => h.send({ type: "session.update", session: sessionBase });
  rtConnect({
    onText: (t) => {
      let j; try { j = JSON.parse(t); } catch (e) { return; }
      if (j.type === "response.audio.delta") sendClient({ type: "audio.delta", audio: j.delta });
      else if (j.type === "response.audio_transcript.delta" || j.type === "response.text.delta") sendClient({ type: "ai.text.delta", text: j.delta });
      else if (j.type === "conversation.item.input_audio_transcription.completed") sendClient({ type: "user.text", text: j.transcript });
      else if (j.type === "input_audio_buffer.speech_started") sendClient({ type: "vad.speech" });
      else if (j.type === "response.done") sendClient({ type: "turn.done" });
      else if (j.type === "session.created" || j.type === "session.updated") sendClient({ type: "rt.ready" });
      else if (j.type === "error") sendClient({ type: "rt.error", message: (j.error && j.error.message) || "realtime 出错" });
    },
    onClose: () => { if (!closed) { closed = true; sendClient({ type: "rt.close" }); try { socket.end(); } catch (e) {} } },
  }).then((h) => {
    up = h; upReady = true;
    sendSession(h);
    while (pending.length) h.send(pending.shift());
  }).catch((e) => { sendClient({ type: "rt.error", message: String((e && e.message) || e) }); try { socket.end(); } catch (e2) {} });
  const feed = wsParser((op, payload) => {
    if (op === 0x8) { closed = true; if (up) up.close(); try { socket.end(); } catch (e) {} return; }
    if (op !== 0x1) return;
    let j; try { j = JSON.parse(payload.toString()); } catch (e) { return; }
    if (j.type === "audio.append") {
      const m = { type: "input_audio_buffer.append", audio: j.audio };
      if (upReady) up.send(m); else pending.push(m);
    } else if (j.type === "context.set") {
      sessionBase.instructions = String(j.text || "").slice(0, 4000);
      if (upReady) sendSession(up); else pending.push({ type: "session.update", session: sessionBase });
    } else if (j.type === "text.send") {
      const msgs = [
        { type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: String(j.text || "") }] } },
        { type: "response.create" },
      ];
      if (upReady) msgs.forEach((m) => up.send(m)); else pending.push(...msgs);
    } else if (j.type === "hangup") { closed = true; if (up) up.close(); try { socket.end(); } catch (e) {} }
  });
  socket.on("data", feed);
  socket.on("error", () => { closed = true; if (up) up.close(); });
  socket.on("close", () => { closed = true; if (up) up.close(); });
});
