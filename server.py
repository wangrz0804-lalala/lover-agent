#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
模拟恋人 App 本地服务
- 托管页面（同目录的 index.html）
- 把 /api/chat 转发给任意 OpenAI 兼容格式的大模型接口（API Key 只在你本机流转）

用法：
    python3 server.py
然后浏览器打开 http://localhost:8787
"""
import json
import socket
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

PORT = 8787


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        if self.path != "/api/chat":
            return self._send_json(404, {"error": "接口不存在"})

        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except Exception:
            return self._send_json(400, {"error": "请求体不是合法 JSON"})

        base = (body.get("baseUrl") or "").rstrip("/")
        key = (body.get("apiKey") or "").strip()
        model = body.get("model") or "qwen-plus"
        stream = bool(body.get("stream"))
        messages = body.get("messages") or []

        if not base:
            return self._send_json(400, {"error": "请在设置里填写模型 API 地址"})
        if not key:
            return self._send_json(400, {"error": "请在设置里填写 API Key"})
        if not messages:
            return self._send_json(400, {"error": "消息为空"})

        payload = json.dumps({
            "model": model,
            "messages": messages,
            "stream": stream,
            "temperature": 0.85,
            "top_p": 0.9,
        }).encode("utf-8")

        req = urllib.request.Request(
            base + "/chat/completions",
            data=payload,
            headers={
                "Authorization": "Bearer " + key,
                "Content-Type": "application/json",
            },
        )
        try:
            resp = urllib.request.urlopen(req, timeout=120)
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "ignore")[:600]
            except Exception:
                pass
            hint = {
                401: "（API Key 无效或没有权限，检查一下 Key 和 API 地址是否匹配）",
                404: "（接口地址不对，或模型名不存在）",
                429: "（触发限流了，稍后再试或检查额度）",
            }.get(e.code, "")
            return self._send_json(e.code, {
                "error": "模型服务返回 %s%s" % (e.code, hint),
                "detail": detail,
            })
        except urllib.error.URLError as e:
            return self._send_json(502, {"error": "无法连接模型服务：%s" % e.reason})
        except Exception as e:
            return self._send_json(502, {"error": "请求模型服务出错：%s" % e})

        if not stream:
            data = resp.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        # SSE 流式透传
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            while True:
                line = resp.readline()
                if not line:
                    break
                self.wfile.write(line)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):  # 静默常规日志
        pass


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None


if __name__ == "__main__":
    print("=" * 46)
    print("  模拟恋人 App 已启动")
    print("  本机打开: http://localhost:%d" % PORT)
    ip = lan_ip()
    if ip:
        print("  手机同 Wi-Fi 打开: http://%s:%d" % (ip, PORT))
    print("  按 Ctrl+C 停止")
    print("=" * 46)
    try:
        ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
