# BriefAI.world — Guía de despliegue en Vercel

## Estructura del proyecto
```
briefai/
├── api/
│   └── news.js          ← Servidor seguro (aquí van las API keys)
├── public/
│   └── index.html       ← La web que ve el usuario
└── vercel.json          ← Configuración de Vercel
```

## Paso 1 — Subir a GitHub (gratuito)
1. Ve a https://github.com y crea una cuenta
2. Pulsa "New repository" → nombre: `briefai` → Public → Create
3. Sube los 3 archivos (api/news.js, public/index.html, vercel.json)

## Paso 2 — Conectar Vercel (gratuito)
1. Ve a https://vercel.com y regístrate con tu cuenta de GitHub
2. Pulsa "Add New Project" → selecciona el repo `briefai`
3. En "Root Directory" pon `/` → pulsa Deploy

## Paso 3 — Añadir las API keys (IMPORTANTE - sin esto no funciona)
En Vercel, ve a tu proyecto → Settings → Environment Variables y añade:

| Variable              | Valor                        |
|-----------------------|------------------------------|
| NEWS_API_KEY          | tu key de newsapi.org        |
| ANTHROPIC_API_KEY     | tu key de anthropic          |

Pulsa Save → ve a Deployments → Redeploy

## Paso 4 — Conectar briefai.world
1. En Vercel → tu proyecto → Settings → Domains
2. Añade `briefai.world`
3. Vercel te dará unos nameservers, cópialos
4. Ve a Namecheap → Domain List → briefai.world → Manage → Nameservers
5. Pega los nameservers de Vercel → Save
6. Espera 10-30 minutos → ¡listo!

## Costes
- GitHub: gratis
- Vercel hosting: gratis
- Vercel Functions (servidor): gratis hasta 100k peticiones/mes
- NewsAPI: gratis hasta 100 peticiones/día (plan developer)
- Anthropic API: ~$0.003 por síntesis
