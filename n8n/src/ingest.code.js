// Corpo do nó Code "Ingest vagas" (workflow ingest-bucket).
// Run Once for All Items. Usa this.helpers.httpRequest (estável entre versões).
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, PORTAL_RUNNER_URL, PORTAL_RUNNER_TOKEN.

const SUPA = $env.SUPABASE_URL
const KEY = $env.SUPABASE_SERVICE_KEY
const RUNNER = $env.PORTAL_RUNNER_URL
const RTOK = $env.PORTAL_RUNNER_TOKEN
const h = this.helpers
const supaHeaders = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const ALLOWED = ['gupy', 'catho', 'vagas']

// 1. Buckets ativos.
const buckets = await h.httpRequest({
  method: 'GET',
  url: `${SUPA}/rest/v1/search_buckets?active=eq.true&select=key,query_terms`,
  headers: supaHeaders,
  json: true,
})

// 2. Para cada bucket × portal × termo, chama o portal-runner. Erro de um
//    portal não derruba a run (continue).
const rows = []
const seen = new Set()
const now = new Date().toISOString()
for (const b of buckets) {
  const qt = b.query_terms || {}
  for (const portal of Object.keys(qt)) {
    if (!ALLOWED.includes(portal)) continue
    for (const term of qt[portal] || []) {
      let resp
      try {
        resp = await h.httpRequest({
          method: 'POST',
          url: `${RUNNER}/search`,
          headers: { Authorization: `Bearer ${RTOK}` },
          body: { portal, query: term, jobage: 14, limit: 20 },
          json: true,
        })
      } catch (e) {
        continue
      }
      for (const r of (resp && resp.results) || []) {
        const key = `${portal}:${r.id}`
        if (seen.has(key)) continue
        seen.add(key)
        rows.push({
          source: portal,
          external_id: String(r.id),
          url: r.url,
          title: r.title,
          company: r.company ?? null,
          location: r.location ?? null,
          description: r.snippet ?? null,
          posted_at: r.date ?? null,
          last_seen_at: now, // first_seen_at NÃO é enviado: default no insert, preservado no upsert
          raw: r,
        })
      }
    }
  }
}

// 3. Upsert em lotes (dedup por source+external_id). merge-duplicates atualiza
//    os campos enviados; first_seen_at fica intacto porque não vai no corpo.
let upserted = 0
for (let i = 0; i < rows.length; i += 200) {
  const chunk = rows.slice(i, i + 200)
  await h.httpRequest({
    method: 'POST',
    url: `${SUPA}/rest/v1/jobs?on_conflict=source,external_id`,
    headers: { ...supaHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: chunk,
    json: true,
  })
  upserted += chunk.length
}

return [{ json: { buckets: buckets.length, rows: rows.length, upserted } }]
