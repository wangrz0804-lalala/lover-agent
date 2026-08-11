import { put } from '@vercel/blob';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
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
