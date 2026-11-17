// BriefAI — descarga los feeds RSS y guarda un archivo con todos los titulares.
// Sin dependencias: solo necesita Node 18+.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MAX_AGE_MS = 48 * 3600 * 1000; // solo noticias de las últimas 48 h
const PER_FEED = 20;                 // máximo de titulares por feed
const TIMEOUT_MS = 15000;
const BATCH = 8;                     // feeds descargados a la vez
const UA = 'Mozilla/5.0 (compatible; BriefAIBot/1.0; +https://briefai.world)';

// ───────────────────────── Utilidades de texto ─────────────────────────
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    if (k === 'nbsp') return ' ';
    try {
      return k.startsWith('#x')
        ? String.fromCodePoint(parseInt(k.slice(2), 16))
        : String.fromCodePoint(parseInt(k.slice(1), 10));
    } catch { return m; }
  });
}

function unCdata(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function stripTags(s) {
  // Algunos feeds mandan el HTML codificado (&lt;p&gt;...), así que se limpia antes y después de decodificar
  const once = decode(unCdata(s).replace(/<[^>]*>/g, ' '));
  return once.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function getTag(block, name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${n}(?:\\s[^>]*[^/])?>([\\s\\S]*?)</${n}>`, 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

function getAttr(block, tag, attr, filter) {
  const re = new RegExp(`<${tag}\\s[^>]*>`, 'gi');
  let m;
  while ((m = re.exec(block))) {
    const t = m[0];
    if (filter && !filter(t)) continue;
    const a = t.match(new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, 'i'));
    if (a) return decode(a[1]);
  }
  return '';
}

function isHttp(u) { return /^https?:\/\//i.test(u || ''); }

// ───────────────────────── Lector de RSS / Atom ─────────────────────────
export function parseFeed(xml) {
  const items = [];
  const re = /<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[2];

    const title = stripTags(getTag(b, 'title'));

    let link = stripTags(getTag(b, 'link'));
    if (!isHttp(link)) {
      link = getAttr(b, 'link', 'href', t => !/rel\s*=\s*["'](?:self|enclosure)["']/i.test(t));
    }
    if (!isHttp(link)) link = stripTags(getTag(b, 'guid'));

    const rawDesc = getTag(b, 'description') || getTag(b, 'summary') || '';
    const rawContent = getTag(b, 'content:encoded') || getTag(b, 'content') || '';
    const summary = stripTags(rawDesc || rawContent).slice(0, 350);

    // Imagen: media:content > media:thumbnail > enclosure > primera <img>
    let image =
      getAttr(b, 'media:content', 'url', t => !/medium\s*=\s*["']video["']/i.test(t)) ||
      getAttr(b, 'media:thumbnail', 'url') ||
      getAttr(b, 'enclosure', 'url', t => /type\s*=\s*["']image\//i.test(t));
    if (!isHttp(image)) {
      const html = decode(unCdata(rawDesc + ' ' + rawContent));
      const img = html.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
      image = img ? img[1] : '';
    }
    if (!isHttp(image)) image = null;

    const dateStr =
      stripTags(getTag(b, 'pubDate')) ||
      stripTags(getTag(b, 'published')) ||
      stripTags(getTag(b, 'updated')) ||
      stripTags(getTag(b, 'dc:date'));
    const ts = Date.parse(dateStr);

    if (title && isHttp(link)) {
      items.push({
        title,
        summary,
        link,
        image,
        published: Number.isNaN(ts) ? null : new Date(ts).toISOString(),
      });
    }
  }
  return items;
}

// ───────────────────────── Descarga ─────────────────────────
async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeLink(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    [...x.searchParams.keys()].forEach(k => {
      if (/^(utm_|at_|cmp|ocid|ref|source)/i.test(k)) x.searchParams.delete(k);
    });
    return x.toString().replace(/\/$/, '');
  } catch { return u; }
}

async function main() {
  const feedsFile = process.env.FEEDS_FILE || path.join(__dirname, 'feeds.json');
  const feeds = JSON.parse(await readFile(feedsFile, 'utf8'));
  const now = Date.now();
  const report = [];
  const all = [];

  for (let i = 0; i < feeds.length; i += BATCH) {
    const batch = feeds.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(async f => {
      const xml = await fetchText(f.url);
      const parsed = parseFeed(xml);
      if (parsed.length === 0) throw new Error('feed vacío o formato no reconocido');
      return parsed;
    }));

    results.forEach((r, idx) => {
      const f = batch[idx];
      if (r.status === 'fulfilled') {
        const fresh = r.value
          .map(it => ({ ...it, published: it.published || new Date(now).toISOString() }))
          .filter(it => now - Date.parse(it.published) <= MAX_AGE_MS)
          .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
          .slice(0, PER_FEED);
        fresh.forEach(it => all.push({ ...it, source: f.name, trust: f.trust, section: f.section }));
        report.push({ name: f.name, section: f.section, url: f.url, status: 'ok', items: fresh.length });
      } else {
        const msg = (r.reason && r.reason.name === 'AbortError') ? 'tiempo agotado' : String(r.reason?.message || r.reason);
        report.push({ name: f.name, section: f.section, url: f.url, status: 'error', items: 0, error: msg });
      }
    });
  }

  // Quitar duplicados (misma URL o mismo titular en la misma sección)
  const seen = new Set();
  const items = all
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
    .filter(it => {
      const k1 = normalizeLink(it.link);
      const k2 = it.section + '|' + it.title.toLowerCase();
      if (seen.has(k1) || seen.has(k2)) return false;
      seen.add(k1); seen.add(k2);
      return true;
    });

  const ok = report.filter(r => r.status === 'ok').length;
  console.log(`\nFeeds OK: ${ok}/${report.length} · Titulares: ${items.length}\n`);
  report.filter(r => r.status === 'error').forEach(r =>
    console.log(`  ✗ ${r.name} [${r.section}] — ${r.error}\n    ${r.url}`));

  if (items.length === 0) {
    console.error('No se obtuvo ningún titular. No se sobrescribe el archivo anterior.');
    process.exit(1);
  }

  const outDir = path.join(ROOT, 'data');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'news.json'),
    JSON.stringify({ updatedAt: new Date(now).toISOString(), count: items.length, items }));
  await writeFile(path.join(outDir, 'report.json'),
    JSON.stringify({ updatedAt: new Date(now).toISOString(), feedsOk: ok, feedsTotal: report.length, feeds: report }, null, 1));
}

// Solo ejecuta main() si se lanza directamente (no al importarlo en pruebas)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
