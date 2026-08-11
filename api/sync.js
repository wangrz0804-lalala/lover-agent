import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, key, data } = req.body;
  if (action === 'get') {
    const val = await kv.get(key);
    return res.status(200).json(val || null);
  }
  if (action === 'set') {
    await kv.set(key, data);
    return res.status(200).json({ success: true });
  }
  res.status(400).json({ error: '无效的操作' });
}
