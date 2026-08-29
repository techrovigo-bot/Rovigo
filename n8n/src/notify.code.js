// Corpo do nó Code "Notificar" (workflows notify-daily e onboarding-hook).
// Run Once for All Items. Envia o top-N de matches novos por tenant via WhatsApp
// (Evolution API) com fallback e-mail (Resend), registra em notifications e marca
// os matches como 'notified'. Só marca no envio bem-sucedido.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, EVOLUTION_URL, EVOLUTION_INSTANCE,
//      EVOLUTION_API_KEY, RESEND_API_KEY, NOTIFY_FROM_EMAIL,
//      NOTIFY_MIN_SCORE (default 60), NOTIFY_TOP (default 5), PANEL_URL (opcional).

const SUPA = $env.SUPABASE_URL
const KEY = $env.SUPABASE_SERVICE_KEY
const h = this.helpers
const supaHeaders = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const MIN = Number($env.NOTIFY_MIN_SCORE || 60)
const TOP = Number($env.NOTIFY_TOP || 5)
const PANEL = $env.PANEL_URL || ''

// tenant_id opcional (onboarding). Ausente = todos os elegíveis (cron).
const firstIn = $input.all().length && $input.all()[0].json ? $input.all()[0].json : {}
const singleTenant = firstIn.tenant_id || (firstIn.body && firstIn.body.tenant_id) || null

// Quem notificar (RPC): tenants ativos com matches novos + contato.
const targets = await h.httpRequest({
  method: 'POST',
  url: `${SUPA}/rest/v1/rpc/tenants_to_notify`,
  headers: { ...supaHeaders, 'Content-Type': 'application/json' },
  body: { p_tenant: singleTenant },
  json: true,
})

async function sendWhatsApp(number, text) {
  const url = $env.EVOLUTION_URL, inst = $env.EVOLUTION_INSTANCE, key = $env.EVOLUTION_API_KEY
  if (!url || !inst || !key) return false
  await h.httpRequest({
    method: 'POST',
    url: `${url}/message/sendText/${inst}`,
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: { number, text },
    json: true,
  })
  return true
}

async function sendEmail(to, subject, text) {
  const key = $env.RESEND_API_KEY, from = $env.NOTIFY_FROM_EMAIL
  if (!key || !from || !to) return false
  await h.httpRequest({
    method: 'POST',
    url: 'https://api.resend.com/emails',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: { from, to, subject, text },
    json: true,
  })
  return true
}

const summary = []
for (const t of targets) {
  // Top-N matches novos (ranked, score alto), com dados da vaga embutidos.
  const matches = await h.httpRequest({
    method: 'GET',
    url: `${SUPA}/rest/v1/job_matches?tenant_id=eq.${t.tenant_id}&status=eq.ranked&score=gte.${MIN}&order=score.desc&limit=${TOP}&select=job_id,score,verdict,jobs(title,company,url)`,
    headers: supaHeaders,
    json: true,
  })
  if (!matches || !matches.length) continue

  const lines = matches.map((m) => {
    const j = m.jobs || {}
    return `• ${j.title || 'Vaga'}${j.company ? ' — ' + j.company : ''} (fit ${m.score})\n  ${j.url || ''}`
  })
  const text = `Novas vagas com bom fit pra você:\n\n${lines.join('\n\n')}${PANEL ? `\n\nVer todas: ${PANEL}` : ''}`
  const subject = `${matches.length} nova(s) vaga(s) com bom fit`

  // Envio: WhatsApp com consentimento, senão e-mail.
  let channel = null
  try {
    if (t.whatsapp_number && t.whatsapp_consent_at && (await sendWhatsApp(t.whatsapp_number, text))) {
      channel = 'whatsapp'
    } else if (await sendEmail(t.email, subject, text)) {
      channel = 'email'
    }
  } catch (e) {
    // falha de envio: não marca como notificado, tenta de novo amanhã
    summary.push({ tenant: t.tenant_id, erro: String(e.message || e) })
    continue
  }
  if (!channel) {
    summary.push({ tenant: t.tenant_id, pulado: 'sem canal (WhatsApp sem consentimento e e-mail não configurado)' })
    continue
  }

  const matchIds = matches.map((m) => m.job_id)

  // Registra a notificação.
  await h.httpRequest({
    method: 'POST', url: `${SUPA}/rest/v1/notifications`,
    headers: { ...supaHeaders, Prefer: 'return=minimal' },
    body: [{ tenant_id: t.tenant_id, channel, status: 'sent', match_ids: matchIds, payload: { text }, sent_at: new Date().toISOString() }],
    json: true,
  })

  // Marca os matches enviados como 'notified' (não voltam no próximo envio).
  const inList = matchIds.map((id) => `"${id}"`).join(',')
  await h.httpRequest({
    method: 'PATCH',
    url: `${SUPA}/rest/v1/job_matches?tenant_id=eq.${t.tenant_id}&job_id=in.(${inList})`,
    headers: { ...supaHeaders, Prefer: 'return=minimal' },
    body: { status: 'notified' },
    json: true,
  })

  summary.push({ tenant: t.tenant_id, canal: channel, enviadas: matchIds.length })
}

return [{ json: { alvos: targets.length, detalhe: summary } }]
