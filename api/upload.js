import { put } from '@vercel/blob';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const APP_TOKEN = process.env.APP_TOKEN || 'bd6829b897af9f18895b5fe5';
  const okToken = req.headers['x-app-token'] === APP_TOKEN || (req.body && req.body.token === APP_TOKEN);
  if (!okToken) return res.status(401).json({ error: 'token 校验失败' });
  try {
    const file = req.body; // 注意：前端需要使用 FormData 发送
    const blob = await put(`avatar_${Date.now()}.png`, file, {
      access: 'public',
    });
    res.status(200).json({ url: blob.url });
  } catch (err) {
    res.status(500).json({ error: '上传失败' });
  }
}
