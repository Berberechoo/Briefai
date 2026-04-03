export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { topic, lang } = req.body;
  if (!topic) return res.status(400).json({ error: 'Missing topic' });

  const NEWS_KEY = process.env.NEWS_API_KEY;
  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;

  try {
    // 1. Fetch real articles from NewsAPI
    const newsUrl = `https://newsapi.org/v2/everything?q=${encodeURIComponent(topic)}&language=en&sortBy=publishedAt&pageSize=12&apiKey=${NEWS_KEY}`;
    const newsRes = await fetch(newsUrl);
    const newsData = await newsRes.json();

    if (newsData.status !== 'ok') {
      return res.status(500).json({ error: newsData.message || 'NewsAPI error' });
    }

    const articles = (newsData.articles || [])
      .filter(a => a.title && a.description && a.title !== '[Removed]')
      .slice(0, 10);

    if (articles.length === 0) {
      return res.status(404).json({ error: 'No articles found for this topic' });
    }

    // 2. Build prompt for Claude
    const LANG_INSTRUCTIONS = {
      en: 'Write the titulo and resumen in English.',
      es: 'Escribe el titulo y resumen en español.',
      fr: 'Écris le titre et le résumé en français.',
      de: 'Schreibe den Titel und die Zusammenfassung auf Deutsch.',
      it: 'Scrivi il titolo e il riassunto in italiano.',
      pt: 'Escreve o título e o resumo em português.',
    };

    const summaries = articles.map((a, i) =>
      `[${i + 1}] ${a.source.name}: "${a.title}" — ${a.description}`
    ).join('\n');

    const langInstruction = LANG_INSTRUCTIONS[lang] || LANG_INSTRUCTIONS['en'];

    const prompt = `You are NewsAI synthesis engine. Analyze these real articles about "${topic}":
${summaries}

${langInstruction}
Respond ONLY with valid JSON array, no backticks, no extra text:
[
  {
    "titulo": "Clear headline max 12 words",
    "resumen": "3-4 sentence neutral synthesis based strictly on the articles above. Include concrete data if present.",
    "fuentes": ["source1","source2","source3"],
    "articulos_usados": [1,2,3],
    "angulo": "geographic region or angle",
    "tendencia": "neutro"
  }
]
Rules: fuentes = real media names from articles used. articulos_usados = 1-based indices. tendencia: neutro/positivo/negativo. Generate exactly 3 items.`;

    // 3. Call Claude API securely from server
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const claudeData = await claudeRes.json();

    if (claudeData.error) {
      return res.status(500).json({ error: 'Claude API error: ' + claudeData.error.message });
    }

    if (!claudeData.content || !Array.isArray(claudeData.content)) {
      return res.status(500).json({ error: 'Respuesta inesperada de Claude: ' + JSON.stringify(claudeData) });
    }

    const text = claudeData.content.map(i => i.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();

    let synthesized;
    try {
      synthesized = JSON.parse(clean);
    } catch (parseErr) {
      return res.status(500).json({ error: 'Error al parsear respuesta de Claude: ' + clean.slice(0, 200) });
    }

    if (!Array.isArray(synthesized) || synthesized.length === 0) {
      return res.status(500).json({ error: 'Claude no devolvió artículos válidos' });
    }

    return res.status(200).json({ synthesized, articles });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
