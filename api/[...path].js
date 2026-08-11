export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: '只允许 POST 请求' });

  try {
    const apiUrl = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
    const apiKey = process.env.ALIYUN_API_KEY;
    const acceptLanguage = req.headers['accept-language'] || '';

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...(acceptLanguage && { 'Accept-Language': acceptLanguage }) // 解决语言报错
      },
      body: JSON.stringify(req.body)
    });

    if (req.body.stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } finally { res.end(); }
      return;
    }

    const rawText = await response.text();
    let data;
    try { data = JSON.parse(rawText); } catch (e) { return res.status(500).json({ error: '阿里云返回异常数据' }); }
    return res.status(response.status).json(data);

  } catch (error) {
    console.error('代理请求错误:', error);
    return res.status(500).json({ error: '请求失败' });
  }
}
