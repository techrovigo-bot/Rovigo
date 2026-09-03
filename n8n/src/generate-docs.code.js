// Corpo do nó Code "Gerar documentos" (workflow generate-docs).
// Run Once for All Items. Disparado pelo painel quando o candidato pede CV e
// carta para uma vaga.
//
// Orquestra: valida cota → carrega perfil e vaga → docgen /prepare-draft →
// OpenRouter (drafter) → /assemble-draft → /prepare-review → OpenRouter
// (reviewer) → /audit → /pdf → Storage → documents + llm_usage.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, DOCGEN_SERVICE_URL,
//      DOCGEN_SERVICE_TOKEN, OPENROUTER_API_KEY, DOC_MODEL.

const SUPA = $env.SUPABASE_URL
const KEY = $env.SUPABASE_SERVICE_KEY
const DOCGEN = $env.DOCGEN_SERVICE_URL
const DTOK = $env.DOCGEN_SERVICE_TOKEN
const OR = $env.OPENROUTER_API_KEY
const MODEL = $env.DOC_MODEL || 'anthropic/claude-sonnet-4.5'
const h = this.helpers
const supa = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const docgenAuth = { Authorization: `Bearer ${DTOK}` }

const firstIn = $input.all().length && $input.all()[0].json ? $input.all()[0].json : {}
const src = firstIn.body && typeof firstIn.body === 'object' ? firstIn.body : firstIn
const tenantId = src.tenant_id || null
const jobId = src.job_id || null

const fail = (motivo, extra) => [{ json: { ok: false, erro: motivo, ...(extra || {}) } }]

if (!tenantId || !jobId) return fail('tenant_id e job_id são obrigatórios')

// --- feature flags e cota ---------------------------------------------------
// A cota existe porque documento custa token de verdade (duas passadas num
// modelo caro). Sem teto, um único tenant queima a margem do mês.
const flags = await h.httpRequest({
  method: 'GET',
  url: `${SUPA}/rest/v1/feature_flags?key=in.(docgen.enabled,docgen.monthly_quota)&select=key,enabled,value`,
  headers: supa,
  json: true,
})
const flagOf = (k) => (flags || []).find((f) => f.key === k)
const enabled = flagOf('docgen.enabled')
if (enabled && enabled.enabled === false) return fail('geração de documentos desligada')

const quotaFlag = flagOf('docgen.monthly_quota')
const limite = quotaFlag && quotaFlag.enabled && quotaFlag.value && quotaFlag.value.limit
if (limite) {
  const usados = await h.httpRequest({
    method: 'POST',
    url: `${SUPA}/rest/v1/rpc/documents_used_this_month`,
    headers: { ...supa, 'Content-Type': 'application/json' },
    body: { p_tenant: tenantId },
    json: true,
  })
  // O par CV+carta conta 2, então precisa de 2 de folga.
  if (Number(usados) + 2 > Number(limite)) {
    return fail('cota mensal de documentos atingida', { usados: Number(usados), limite: Number(limite) })
  }
}

// --- perfil, e-mail e vaga --------------------------------------------------
const tenants = await h.httpRequest({
  method: 'GET',
  url: `${SUPA}/rest/v1/tenants?id=eq.${tenantId}&select=id,user_id,profiles(*)`,
  headers: supa,
  json: true,
})
const tenant = tenants && tenants[0]
if (!tenant) return fail('tenant não encontrado')
const prof = Array.isArray(tenant.profiles) ? tenant.profiles[0] : tenant.profiles
if (!prof) return fail('perfil não encontrado')

const hist = Array.isArray(prof.professional_history) ? prof.professional_history : []
if (!hist.length) {
  return fail('perfil sem histórico profissional: sem âncora, a auditoria removeria tudo')
}

// O e-mail mora em auth.users, não no perfil — e sem ele o CV fica sem contato
// legível por ATS, que é justamente o que o parser procura.
let email = null
try {
  const u = await h.httpRequest({
    method: 'GET',
    url: `${SUPA}/auth/v1/admin/users/${tenant.user_id}`,
    headers: supa,
    json: true,
  })
  email = (u && u.email) || null
} catch (e) {
  // sem e-mail o documento ainda sai; só perde a linha de contato
}

const jobs = await h.httpRequest({
  method: 'GET',
  url: `${SUPA}/rest/v1/jobs?id=eq.${jobId}&select=id,title,company,location,description,url`,
  headers: supa,
  json: true,
})
const job = jobs && jobs[0]
if (!job) return fail('vaga não encontrada')

const profile = {
  fullName: prof.full_name || null,
  headline: prof.headline || null,
  email,
  targetRoles: prof.target_roles || [],
  seniority: prof.seniority || null,
  cities: prof.cities || [],
  skills: prof.skills || [],
  languages: prof.languages || [],
  history: hist,
}

// --- marca como 'generating' ------------------------------------------------
// Grava antes de começar para o painel poder mostrar o estado enquanto roda, e
// para uma falha no meio deixar rastro em vez de silêncio.
const upsertDocs = async (rows) =>
  h.httpRequest({
    method: 'POST',
    url: `${SUPA}/rest/v1/documents?on_conflict=tenant_id,job_id,kind`,
    headers: { ...supa, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: rows,
    json: true,
  })

const base = { tenant_id: tenantId, job_id: jobId, model: MODEL, error: null }
let docs = await upsertDocs([
  { ...base, kind: 'cv', status: 'generating' },
  { ...base, kind: 'cover_letter', status: 'generating' },
])
const idOf = (kind) => (docs.find((d) => d.kind === kind) || {}).id

const marcarFalha = async (msg) => {
  await h.httpRequest({
    method: 'PATCH',
    url: `${SUPA}/rest/v1/documents?tenant_id=eq.${tenantId}&job_id=eq.${jobId}`,
    headers: { ...supa, Prefer: 'return=minimal' },
    body: { status: 'failed', error: String(msg).slice(0, 500) },
    json: true,
  })
}

const chamarLlm = async (prep, temperature) => {
  const r = await h.httpRequest({
    method: 'POST',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: { Authorization: `Bearer ${OR}`, 'Content-Type': 'application/json' },
    body: {
      model: MODEL,
      temperature,
      messages: [
        { role: 'system', content: prep.system },
        { role: 'user', content: prep.user },
      ],
    },
    json: true,
  })
  const content = (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || ''
  return { content, usage: r.usage || {} }
}

try {
  // --- drafter --------------------------------------------------------------
  const prep = await h.httpRequest({
    method: 'POST',
    url: `${DOCGEN}/prepare-draft`,
    headers: docgenAuth,
    body: { profile, job },
    json: true,
  })
  const draftLlm = await chamarLlm(prep, 0.3)
  const assembled = await h.httpRequest({
    method: 'POST',
    url: `${DOCGEN}/assemble-draft`,
    headers: docgenAuth,
    body: { llm: draftLlm.content },
    json: true,
  })
  if (!assembled.cv || !assembled.coverLetter) {
    throw new Error('drafter não devolveu CV e carta')
  }

  // --- reviewer + auditoria de grounding ------------------------------------
  // O reviewer julga o que é semântico; a auditoria aplica a regra dura e
  // remove o que não tem âncora no perfil.
  const prepReview = await h.httpRequest({
    method: 'POST',
    url: `${DOCGEN}/prepare-review`,
    headers: docgenAuth,
    body: { profile, job, draft: assembled },
    json: true,
  })
  const reviewLlm = await chamarLlm(prepReview, 0)
  const audited = await h.httpRequest({
    method: 'POST',
    url: `${DOCGEN}/audit`,
    headers: docgenAuth,
    body: { profile, draft: assembled, llmReview: reviewLlm.content },
    json: true,
  })

  // --- PDF + Storage --------------------------------------------------------
  // O docgen converte e sobe direto. Trazer o PDF para cá em base64 não
  // funciona: o Code node serializa Buffer como JSON e o arquivo sobe
  // corrompido ({"type":"Buffer","data":[...]} no lugar dos bytes).
  const pdfs = await h.httpRequest({
    method: 'POST',
    url: `${DOCGEN}/pdf`,
    headers: docgenAuth,
    body: {
      profile,
      draft: audited.clean,
      store: {
        tenantId,
        cvDocumentId: idOf('cv'),
        coverDocumentId: idOf('cover_letter'),
      },
    },
    json: true,
  })
  if (!pdfs.cvPath || !pdfs.coverPath) throw new Error('docgen não devolveu os caminhos do Storage')
  const cvPath = pdfs.cvPath
  const coverPath = pdfs.coverPath

  // --- grava o resultado ----------------------------------------------------
  const relatorio = audited.report || {}
  docs = await upsertDocs([
    {
      ...base,
      kind: 'cv',
      status: 'ready',
      content_md: audited.clean.cv,
      storage_path: cvPath,
      grounding_report: relatorio,
    },
    {
      ...base,
      kind: 'cover_letter',
      status: 'ready',
      content_md: audited.clean.coverLetter,
      storage_path: coverPath,
      grounding_report: relatorio,
    },
  ])

  // --- telemetria de custo --------------------------------------------------
  const somaTokens = (k) => (draftLlm.usage[k] || 0) + (reviewLlm.usage[k] || 0)
  await h.httpRequest({
    method: 'POST',
    url: `${SUPA}/rest/v1/llm_usage`,
    headers: { ...supa, Prefer: 'return=minimal' },
    body: [
      {
        tenant_id: tenantId,
        workflow: 'generate-docs',
        model: MODEL,
        tokens_in: somaTokens('prompt_tokens'),
        tokens_out: somaTokens('completion_tokens'),
        meta: { job_id: jobId, drafter: draftLlm.usage, reviewer: reviewLlm.usage },
      },
    ],
    json: true,
  })

  const claims = relatorio.claims || []
  return [
    {
      json: {
        ok: true,
        tenant_id: tenantId,
        job_id: jobId,
        cv_document_id: idOf('cv'),
        cover_document_id: idOf('cover_letter'),
        claims: claims.length,
        removidos: (relatorio.removed || []).length,
        esticoes: (relatorio.stretches || []).length,
        tokens_in: somaTokens('prompt_tokens'),
        tokens_out: somaTokens('completion_tokens'),
      },
    },
  ]
} catch (e) {
  const msg = (e && e.message) || String(e)
  await marcarFalha(msg)
  return fail(msg, { tenant_id: tenantId, job_id: jobId })
}
