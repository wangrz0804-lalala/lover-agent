# 阿里云部署（OSS + FC）

Vercel 域名在国内常被 DNS 污染，此目录为阿里云备选部署：前端静态站走 OSS，后端走函数计算 FC，均为阿里云默认域名，任何国内网络可直连。

## 线上地址

- 前端：https://lover-app-wrz0804.oss-cn-beijing.aliyuncs.com/
- 后端：https://lover-api-qleohpgkdt.cn-beijing.fcapp.run/

## 架构

- `server.js`：零依赖 Node HTTP 服务（FC custom runtime）。
  - `POST /chat`：模型代理，服务端持有 Token Plan 的 API Key，透传 SSE 流。
  - `POST /sync`：多端同步，落到私有 bucket `lover-sync-wrz0804` 的 `sync/<key>.json`（OSS V1 签名）。
  - 所有接口校验 `X-App-Token`（与前端 `APP_TOKEN` 常量一致）。
- 前端 `index.html`：`API_BASE` 指向上面的 FC 地址，跨域调用。

## 环境变量（FC 控制台配置，勿入库）

APP_TOKEN / MODEL_KEY / UPSTREAM / OSS_AK_ID / OSS_AK_SECRET / OSS_BUCKET

## 重新部署

后端：

```bash
cd aliyun && zip -q code.zip server.js
# 用 base64(code.zip) 组装 body，调用：
aliyun fc UpdateFunction --functionName lover-api --body '{"code":{"zipFile":"<base64>"}}' --profile lover-deploy
```

前端：

```bash
aliyun oss cp index.html oss://lover-app-wrz0804/index.html --meta "Content-Type:text/html;charset=utf-8" --profile lover-deploy
# 覆盖确认时输入 y
```
