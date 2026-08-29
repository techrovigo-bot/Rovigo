// Corpo do nó Code "Embutir vagas" (workflow embed-jobs).
// Run Once for All Items. Pega vagas sem embedding, gera vetores no OpenAI em
// lote e grava via RPC set_job_embeddings. Roda entre o ingest e o rank.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENAI_API_KEY,
//      EMBED_MODEL (default text-embedding-3-small), EMBED_MAX (500), EMBED_BATCH (100).

const SUPA = $env.SUPABASE_URL
const KEY = $env.SUPABASE_SERVICE_KEY
const OA = $env.OPENAI_API_KEY
const MODEL = $env.EMBED_MODEL || 'text-embedding-3-small'
const MAX = Number($env.EMBED_MAX || 500)
const BATCH = Number($env.EMBED_BATCH || 100)
const h = this.helpers
const supa = { apikey: KEY, Authorization: `Bearer ${KEY}` }

// Vagas ainda sem embedding, mais recentes primeiro (limita custo por run).
const jobs = await h.httpRequest({
  method: 'GET',
  url: `${SUPA}/rest/v1/jobs?embedding=is.null&order=first_seen_at.desc&limit=${MAX}&select=id,title,company,description`,
  headers: supa,
  json: true,
})
if (!jobs || !jobs.length) return [{ json: { embedded: 0 } }]

const buildText = (j) => `${j.title || ''}\n${j.company || ''}\n${(j.description || '').slice(0, 2000)}`.trim()

let embedded = 0
let tokensIn = 0
for (let i = 0; i < jobs.length; i += BATCH) {
  const chunk = jobs.slice(i, i + BATCH)
  const input = chunk.map(buildText)
  const resp = await h.httpRequest({
    method: 'POST',
    url: 'https://api.openai.com/v1/embeddings',
    headers: { Authorization: `Bearer ${OA}`, 'Content-Type': 'application/json' },
    body: { model: MODEL, input },
    json: true,
  })
  // resp.data[i].index mapeia de volta para o texto do input.
  const rows = resp.data.map((d) => ({ id: chunk[d.index].id, embedding: d.embedding }))
  await h.httpRequest({
    method: 'POST',
    url: `${SUPA}/rest/v1/rpc/set_job_embeddings`,
    headers: { ...supa, 'Content-Type': 'application/json' },
    body: { p: rows },
    json: true,
  })
  embedded += rows.length
  tokensIn += (resp.usage && resp.usage.prompt_tokens) || 0
}

if (tokensIn) {
  await h.httpRequest({
    method: 'POST', url: `${SUPA}/rest/v1/llm_usage`,
    headers: { ...supa, Prefer: 'return=minimal' },
    body: [{ workflow: 'embed-jobs', model: MODEL, tokens_in: tokensIn, tokens_out: 0 }],
    json: true,
  })
}

return [{ json: { embedded, tokens_in: tokensIn } }]
