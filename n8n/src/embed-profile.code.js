// Corpo do nó Code "Embutir perfil" (primeiro nó do onboarding-hook).
// Run Once for All Items. Lê tenant_id do input (webhook), gera o embedding do
// perfil no OpenAI, grava via RPC set_profile_embedding e propaga o tenant_id
// adiante para o nó Rank. O painel chama /webhook/onboarding no cadastro E em
// toda atualização de perfil, então o embedding fica sempre fresco.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENAI_API_KEY, EMBED_MODEL.

const SUPA = $env.SUPABASE_URL
const KEY = $env.SUPABASE_SERVICE_KEY
const OA = $env.OPENAI_API_KEY
const MODEL = $env.EMBED_MODEL || 'text-embedding-3-small'
const h = this.helpers
const supa = { apikey: KEY, Authorization: `Bearer ${KEY}` }

const firstIn = $input.all().length && $input.all()[0].json ? $input.all()[0].json : {}
const tenant = firstIn.tenant_id || (firstIn.body && firstIn.body.tenant_id) || null
if (!tenant) return [{ json: { error: 'sem tenant_id no input' } }]

const profs = await h.httpRequest({
  method: 'GET',
  url: `${SUPA}/rest/v1/profiles?tenant_id=eq.${tenant}&select=target_roles,skills,seniority,headline,professional_history`,
  headers: supa,
  json: true,
})
const p = profs && profs[0]
if (!p) return [{ json: { tenant_id: tenant, warning: 'perfil não encontrado' } }]

const text = [
  (p.target_roles || []).join(', '),
  (p.skills || []).join(', '),
  p.seniority || '',
  p.headline || '',
  p.professional_history ? JSON.stringify(p.professional_history).slice(0, 2000) : '',
].filter(Boolean).join('\n')

const resp = await h.httpRequest({
  method: 'POST',
  url: 'https://api.openai.com/v1/embeddings',
  headers: { Authorization: `Bearer ${OA}`, 'Content-Type': 'application/json' },
  body: { model: MODEL, input: text || '(perfil vazio)' },
  json: true,
})
const vec = resp.data[0].embedding

await h.httpRequest({
  method: 'POST',
  url: `${SUPA}/rest/v1/rpc/set_profile_embedding`,
  headers: { ...supa, 'Content-Type': 'application/json' },
  body: { p_tenant: tenant, p_embedding: JSON.stringify(vec) },
  json: true,
})

if (resp.usage && resp.usage.prompt_tokens) {
  await h.httpRequest({
    method: 'POST', url: `${SUPA}/rest/v1/llm_usage`,
    headers: { ...supa, Prefer: 'return=minimal' },
    body: [{ tenant_id: tenant, workflow: 'embed-profile', model: MODEL, tokens_in: resp.usage.prompt_tokens, tokens_out: 0 }],
    json: true,
  })
}

// Propaga tenant_id para o nó Rank (próximo na cadeia do onboarding).
return [{ json: { tenant_id: tenant, embedded: true } }]
