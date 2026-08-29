// Corpo do nó Code "Rank por tenant" (workflow rank-daily).
// Run Once for All Items. Orquestra: tenants → RPC de vagas candidatas →
// rank-service /prepare (gates + prompt) → OpenRouter (LLM) → /assemble (score)
// → upsert em job_matches + telemetria em llm_usage.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, RANK_SERVICE_URL, RANK_SERVICE_TOKEN,
//      OPENROUTER_API_KEY, RANK_MODEL (opcional).

const SUPA = $env.SUPABASE_URL
const KEY = $env.SUPABASE_SERVICE_KEY
const RANK = $env.RANK_SERVICE_URL
const RTOK = $env.RANK_SERVICE_TOKEN
const OR = $env.OPENROUTER_API_KEY
const MODEL = $env.RANK_MODEL || 'anthropic/claude-3.5-haiku'
const h = this.helpers
const supaHeaders = { apikey: KEY, Authorization: `Bearer ${KEY}` }

const mapVerdict = (v) => (v === 'pass' || v === 'fail' || v === 'flag' ? v : null)

// tenant_id opcional do input: onboarding-hook (webhook) passa um; o cron não
// passa nada e ranqueia todos os tenants com direito.
const inItems = $input.all()
const firstIn = inItems.length && inItems[0].json ? inItems[0].json : {}
const singleTenant = firstIn.tenant_id || (firstIn.body && firstIn.body.tenant_id) || null

// Billing: no cron, expira os trials vencidos antes de selecionar (mantém o
// status coerente na UI). No modo single (onboarding), não precisa.
if (!singleTenant) {
  try {
    await h.httpRequest({ method: 'POST', url: `${SUPA}/rest/v1/rpc/expire_trials`, headers: { ...supaHeaders, 'Content-Type': 'application/json' }, body: {}, json: true })
  } catch (e) { /* segue mesmo se falhar */ }
}

// Entitlement: pagos ativos, ou trials ainda no prazo.
const nowIso = new Date().toISOString()
const tenantsUrl = singleTenant
  ? `${SUPA}/rest/v1/tenants?id=eq.${singleTenant}&select=id,profiles(*)`
  : `${SUPA}/rest/v1/tenants?subscription_status=eq.active&or=(tier.neq.trial,trial_ends_at.gt.${nowIso})&select=id,profiles(*)`
const tenants = await h.httpRequest({ method: 'GET', url: tenantsUrl, headers: supaHeaders, json: true })

const summary = []
for (const t of tenants) {
  const prof = Array.isArray(t.profiles) ? t.profiles[0] : t.profiles
  if (!prof) continue

  const profile = {
    targetRoles: prof.target_roles || [],
    seniority: prof.seniority || undefined,
    cities: prof.cities || [],
    acceptsWorkModels: prof.accepts_work_models || [],
    languages: prof.languages || [],
    skills: prof.skills || [],
    contractPreference: prof.contract_preference || 'any',
    summary: prof.headline || (prof.professional_history ? JSON.stringify(prof.professional_history) : undefined),
  }

  // Vagas candidatas (recentes, não avaliadas, ordenadas por pgvector).
  const jobsRaw = await h.httpRequest({
    method: 'POST',
    url: `${SUPA}/rest/v1/rpc/jobs_for_tenant`,
    headers: { ...supaHeaders, 'Content-Type': 'application/json' },
    body: { p_tenant: t.id, p_limit: 30, p_days: 3 },
    json: true,
  })
  if (!jobsRaw || !jobsRaw.length) continue

  const jobs = jobsRaw.map((j) => ({
    id: j.id, source: j.source, title: j.title, company: j.company,
    location: j.location, workModel: j.work_model, description: j.description,
    contractType: j.contract_type || null, deadline: j.deadline,
  }))

  // Estágio 1 + prompt.
  const prep = await h.httpRequest({
    method: 'POST', url: `${RANK}/prepare`,
    headers: { Authorization: `Bearer ${RTOK}` },
    body: { profile, jobs }, json: true,
  })

  let judged = { results: [] }
  let usage = {}
  if (prep.survivors && prep.survivors.length) {
    const llm = await h.httpRequest({
      method: 'POST', url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { Authorization: `Bearer ${OR}`, 'Content-Type': 'application/json' },
      body: {
        model: MODEL, temperature: 0, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: prep.system },
          { role: 'user', content: prep.user },
        ],
      },
      json: true,
    })
    const content = (llm.choices && llm.choices[0] && llm.choices[0].message && llm.choices[0].message.content) || '{}'
    usage = llm.usage || {}
    judged = await h.httpRequest({
      method: 'POST', url: `${RANK}/assemble`,
      headers: { Authorization: `Bearer ${RTOK}` },
      body: { profile, survivors: prep.survivors, llm: content }, json: true,
    })
  }

  // Linhas de job_matches: vetados (sem score) + avaliados.
  const matchRows = []
  for (const v of prep.vetoed || []) {
    matchRows.push({
      tenant_id: t.id, job_id: v.jobId, status: 'ranked',
      location_verdict: mapVerdict(v.locationVerdict),
      language_verdict: mapVerdict(v.languageVerdict),
      language_note: v.languageNote ?? null,
      gaps: v.gaps || [], strengths: [], model: null,
    })
  }
  for (const r of judged.results || []) {
    matchRows.push({
      tenant_id: t.id, job_id: r.jobId, status: 'ranked',
      score: r.overall ?? null,
      score_technical: r.scores && r.scores.technical,
      score_experience: r.scores && r.scores.experience,
      score_behavioral: r.scores && r.scores.behavioral,
      score_career: r.scores && r.scores.career,
      verdict: r.verdict ?? null,
      location_verdict: mapVerdict(r.locationVerdict),
      language_verdict: mapVerdict(r.languageVerdict),
      language_note: r.languageNote ?? null,
      strengths: r.strengths || [], gaps: r.gaps || [], model: MODEL,
    })
  }

  if (matchRows.length) {
    await h.httpRequest({
      method: 'POST',
      url: `${SUPA}/rest/v1/job_matches?on_conflict=tenant_id,job_id`,
      headers: { ...supaHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: matchRows, json: true,
    })
  }

  // Telemetria de custo (cost_brl fica no default 0; conversão de preço é passo futuro).
  if (usage && usage.total_tokens) {
    await h.httpRequest({
      method: 'POST', url: `${SUPA}/rest/v1/llm_usage`,
      headers: { ...supaHeaders, Prefer: 'return=minimal' },
      body: [{
        tenant_id: t.id, workflow: 'rank-daily', model: MODEL,
        tokens_in: usage.prompt_tokens || 0, tokens_out: usage.completion_tokens || 0, meta: usage,
      }],
      json: true,
    })
  }

  summary.push({
    tenant: t.id, candidatas: jobs.length,
    avaliadas: (judged.results || []).length, vetadas: (prep.vetoed || []).length,
  })
}

// Em modo single (onboarding), propaga o tenant_id adiante para o nó Notify.
const out = { tenants: tenants.length, detalhe: summary }
if (singleTenant) out.tenant_id = singleTenant
return [{ json: out }]
