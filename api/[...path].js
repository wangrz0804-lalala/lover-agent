export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    try {
      const apiUrl = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
      const apiKey = process.env.ALIYUN_API_KEY;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(req.body)
      });
      const rawText = await response.text();
      let data;
      try { data = JSON.parse(rawText); } catch (e) { return res.status(500).json({ error: '阿里云返回了奇怪格式: ' + rawText.slice(0, 100) }); }
      return res.status(200).json(data);
    } catch (error) {
      return res.status(500).json({ error: '服务器请求失败: ' + error.message });
    }
  }
  return res.status(405).json({ error: '只允许 POST 请求' });
}
