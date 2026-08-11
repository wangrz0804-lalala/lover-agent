export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST') {
    try {
      // 阿里云接口地址
      const apiUrl = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
      const apiKey = process.env.ALIYUN_API_KEY;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(req.body)
      });

      // 重点修正：如果前端要求“流式输出”，我们用管道直接透传数据
      if (req.body.stream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // 读取阿里云的流，原封不动传给手机前端
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            res.write(chunk);
          }
        } finally {
          res.end();
        }
        return;
      }

      // 如果前端不要流式输出，我们再解析为普通的 JSON
      const rawText = await response.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch (e) {
        return res.status(500).json({ error: '阿里云返回了奇怪格式: ' + rawText.slice(0, 100) });
      }
      // ✅ 关键修复：把之前写死的 200，改回阿里云返回的真实状态码。
      return res.status(response.status).json(data);

    } catch (error) {
      console.error('中转请求出错:', error);
      return res.status(500).json({ error: '服务器请求失败: ' + error.message });
    }
  }

  return res.status(405).json({ error: '只允许 POST 请求' });
}
