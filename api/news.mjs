export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, topic, lang, section } = req.body;
  const NEWS_KEY = process.env.NEWS_API_KEY;
  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;

  const TRUST = {
    'Reuters':98,'Associated Press':97,'AP News':97,'BBC News':96,
    'The New York Times':95,'The Guardian':94,'Financial Times':94,
    'Bloomberg':93,'The Economist':93,'NPR':92,'The Washington Post':90,
    'Le Monde':91,'Der Spiegel':90,'Al Jazeera English':88,'CNN':87,
    'El País':89,'France 24':88,'Deutsche Welle':89,'Euronews':85,
    'Forbes':82,'Business Insider':78,'NBC News':88,'ABC News':87,
    'CBS News':87,'Fox News':75,'The Hill':82,'Politico':85,
    'Axios':86,'The Atlantic':88,'Time':87,'Newsweek':78,
    'USA Today':82,'Wall Street Journal':92,'Los Angeles Times':88,
    'ESPN':85,'Sky Sports':84,'BBC Sport':86,'The Athletic':87,
    'Autosport':85,'Motorsport.com':84,'RaceFans':83,
    'Rolling Stone':82,'Billboard':83,'NME':80,'Pitchfork':81,
    'Nature':96,'Science':96,'New Scientist':88,'Scientific American':89,
    'TMZ':65,'People':70,'Us Weekly':68,'Entertainment Weekly':72,
  };

  const SECTION_QUERIES = {
    usa:        { q: null, country: 'us', category: 'general' },
    world:      { q: 'world international news', country: null },
    sports:     { q: 'sports football basketball soccer', country: null },
    motor:      { q: 'F1 Formula 1 MotoGP motorsport racing', country: null },
    economy:    { q: 'economy markets finance stocks', country: null },
    tech:       { q: 'technology AI artificial intelligence innovation', country: null },
    climate:    { q: 'climate change environment global warming', country: null },
    art:        { q: 'art culture museum exhibition', country: null },
    music:      { q: 'music album concert artist', country: null },
    celebrity:  { q: 'celebrity gossip entertainment Hollywood', country: null },
    science:    { q: 'science discovery research space', country: null },
    politics:   { q: 'politics government policy elections', country: null },
  };

  function getTrust(name) {
    if (!name) return 65;
    if (TRUST[name]) return TRUST[name];
    const found = Object.entries(TRUST).find(([k]) =>
      name.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(name.toLowerCase())
    );
    return found ? found[1] : 65;
  }

  async function fetchArticles(sectionKey) {
    const cfg = SECTION_QUERIES[sectionKey];
    if (!cfg) return [];
    let url;
    if (cfg.country) {
      url = `https://newsapi.org/v2/top-headlines?country=${cfg.country}&pageSize=20&apiKey=${NEWS_KEY}`;
    } else {
      url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(cfg.q)}&language=en&sortBy=publishedAt&pageSize=20&apiKey=${NEWS_KEY}`;
    }
    const r = await fetch(url);
    const d = await r.json();
    if (d.status !== 'ok') return [];
    return (d.articles || []).filter(a => a.title && a.title !== '[Removed]');
  }

  async function extractTopics(articles, sectionLabel) {
    const headlines = articles.slice(0, 16).map(a => a.title).join('\n');
    const prompt = `Given these ${sectionLabel} news headlines, extract the 4 most trending specific topics right now.
Headlines:
${headlines}

Respond ONLY with a JSON array of exactly 4 short topic labels in English (2-5 words each), no backticks:
["Topic 1","Topic 2","Topic 3","Topic 4"]
Be specific — use real names and events from the headlines.`;

    const cr = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 150, messages: [{ role: 'user', content: prompt }] }),
    });
    const cd = await cr.json();
    if (cd.error || !cd.content) return [];
    const text = cd.content.map(i => i.text || '').join('');
    try {
      return JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch { return []; }
  }

  // ── ACTION: load a single section ────────────────────────────────────────
  if (action === 'section') {
    if (!section) return res.status(400).json({ error: 'Missing section' });
    try {
      const articles = await fetchArticles(section);
      if (articles.length === 0) return res.status(200).json({ topics: [], top4: [] });

      const sectionLabel = section.charAt(0).toUpperCase() + section.slice(1);
      const topics = await extractTopics(articles, sectionLabel);

      const top4 = topics.slice(0, 4).map(topic => {
        const match = articles.find(a =>
          a.urlToImage && topic.toLowerCase().split(' ').some(w => w.length > 3 && a.title.toLowerCase().includes(w))
        );
        const fallbackImg = articles.find(a => a.urlToImage);
        return { topic, image: match?.urlToImage || fallbackImg?.urlToImage || null };
      });

      return res.status(200).json({ topics, top4 });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── ACTION: generate full article ────────────────────────────────────────
  if (action === 'article') {
    if (!topic) return res.status(400).json({ error: 'Missing topic' });
    try {
      const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(topic)}&language=en&sortBy=publishedAt&pageSize=15&apiKey=${NEWS_KEY}`;
      const r = await fetch(url);
      const d = await r.json();
      if (d.status !== 'ok') return res.status(500).json({ error: d.message });

      const articles = (d.articles || [])
        .filter(a => a.title && a.description && a.title !== '[Removed]')
        .slice(0, 12);
      if (articles.length === 0) return res.status(404).json({ error: 'No articles found for this topic' });

      const image = (articles.find(a => a.urlToImage?.startsWith('http')) || {}).urlToImage || null;
      const sources = [...new Map(
        articles.map(a => [a.source?.name, { name: a.source?.name || 'Unknown', score: getTrust(a.source?.name) }])
      ).values()];

      const LANG = {
        en:'Write entirely in English.',
        es:'Escribe completamente en español.',
        fr:'Écris entièrement en français.',
        de:'Schreibe vollständig auf Deutsch.',
        it:'Scrivi interamente in italiano.',
        pt:'Escreve completamente em português.',
      };

      const summaries = articles.map((a, i) =>
        `[${i+1}] ${a.source?.name||'Unknown'}: "${a.title}" — ${a.description}`
      ).join('\n');

      const prompt = `You are BriefAI, an unbiased AI journalist. Write a complete professional news article about "${topic}" based on these real sources:

${summaries}

${LANG[lang]||LANG['es']}

Respond ONLY with valid JSON, no backticks:
{
  "titulo": "Compelling journalistic headline (max 15 words)",
  "resumen": "Executive summary 120-150 words. Neutral and informative.",
  "articulo": "Full 2000-2500 word article. Well-structured flowing paragraphs. Cover: background, key facts, different perspectives, analysis, conclusion. Professional journalistic style. No subheadings.",
  "fuentes_usadas": [1,2,3,4,5],
  "angulo": "Main angle",
  "tendencia": "neutro"
}`;

      const cr = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }),
      });

      const cd = await cr.json();
      if (cd.error) return res.status(500).json({ error: 'Claude: ' + cd.error.message });
      if (!cd.content) return res.status(500).json({ error: 'No response from Claude' });

      const text = cd.content.map(i => i.text||'').join('');
      const clean = text.replace(/```json|```/g,'').trim();
      let article;
      try { article = JSON.parse(clean); }
      catch(e) { return res.status(500).json({ error: 'Parse error: '+clean.slice(0,200) }); }

      const rawArticles = (article.fuentes_usadas||[])
        .map(i => articles[i-1]).filter(Boolean)
        .map(a => ({ title:a.title, source:a.source?.name||'Unknown', url:a.url, publishedAt:a.publishedAt }));

      return res.status(200).json({ article, image, sources, rawArticles });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
