# 阿里云后端（函数计算 FC + OSS 同步）

## 线上地址

- 前端（GitHub Pages，浏览器直接渲染）：https://wangrz0804-lalala.github.io/lover-agent/
- 后端（阿里云 FC，国内任意网络可直连）：https://lover-api-qleohpgkdt.cn-beijing.fcapp.run/

## 为什么前端不走阿里云

OSS 默认域名（*.aliyuncs.com）与 FC 默认域名（*.fcapp.run）均有安全策略：
响应强制带 `Content-Disposition: attachment`（OSS 还会带 `x-oss-force-download: true`），
浏览器只会下载、不会渲染页面。函数内设置 `Content-Type: text/html` /
`Content-Disposition: inline`、OSS 签名 URL 加 `response-content-disposition=inline`
均会被策略覆盖，无开关可关。官方唯一解法是绑定自己的域名（中国内地需 ICP 备案）。
因此页面托管在 GitHub Pages，API 走 FC；将来若买了备案域名，FC 已能直接吐出
页面（见下），绑个自定义域名即可整体切回阿里云。

## 架构

- `server.js`：零依赖 Node HTTP 服务（FC custom runtime）。
  - `GET /`：直接吐出前端页面（index.html/manifest/icon 打包在代码 zip 里，
    默认域名下会被强制下载，仅供将来绑定自定义域名后使用）。
  - `GET /health`：健康检查。
  - `POST /chat`：模型代理，服务端持有 Token Plan 的 API Key，透传 SSE 流。
  - `POST /sync`：多端同步，落到私有 bucket `lover-sync-wrz0804` 的
    `sync/<key>.json`（OSS V1 签名）。
  - `/chat`、`/sync` 校验 `X-App-Token`（与前端 `APP_TOKEN` 常量一致）。
- 仓库根目录 `index.html`：`API_BASE` 指向上面的 FC 地址，跨域调用（FC 已开 CORS）。
- OSS bucket `lover-app-wrz0804` 内仍留有一份前端副本（仅存档，默认域名会强制下载）。

## 环境变量（FC 控制台配置，勿入库）

APP_TOKEN / MODEL_KEY / UPSTREAM / OSS_AK_ID / OSS_AK_SECRET / OSS_BUCKET

## 重新部署

后端（zip 内需包含 server.js、index.html、manifest.webmanifest、icon.png）：

```bash
cd gh-deploy && zip -qj /tmp/lover-code.zip aliyun/server.js index.html manifest.webmanifest icon.png
python3 -c "import base64,json; open('/tmp/lover-body.json','w').write(json.dumps({'code':{'zipFile':base64.b64encode(open('/tmp/lover-code.zip','rb').read()).decode()}))"
aliyun fc UpdateFunction --functionName lover-api --body-file /tmp/lover-body.json --profile lover-deploy
```

前端：推到仓库 main 分支即可，GitHub Pages 自动发布。
