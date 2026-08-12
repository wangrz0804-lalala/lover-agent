import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Token');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const APP_TOKEN = process.env.APP_TOKEN || 'bd6829b897af9f18895b5fe5';
  const okToken = req.headers['x-app-token'] === APP_TOKEN || (req.body && req.body.token === APP_TOKEN);
  if (!okToken) return res.status(401).json({ error: 'token 校验失败' });

  const { action, key, data } = req.body;
  if (action === 'get') {
    const val = await kv.get(key);
    return res.status(200).json(val !== null && val !== undefined ? val : null);
  }
  if (action === 'set') {
    await kv.set(key, data);
    return res.status(200).json({ success: true });
  }
  return res.status(400).json({ error: '无效的操作' });
}
