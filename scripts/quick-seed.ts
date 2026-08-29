// quick-seed.ts — popula a /vagas com dados REAIS sem Docker/n8n.
// Busca vagas na Gupy, aplica os gates, ranqueia via OpenRouter e grava em
// job_matches do seu Supabase. Reusa o CLI da Gupy e o pacote ranking/.
//
// Uso (a partir da RAIZ do repo, com o .env preenchido):
//   bun run scripts/quick-seed.ts
//
// .env precisa de: SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENROUTER_API_KEY.
// Opcional: RANK_MODEL (default claude-3.5-haiku), TENANT_ID (senão usa o
// primeiro perfil com completeness>0 — o que você acabou de preencher).

import { join } from "node:path"
import { readFileSync } from "node:fs"
import { partitionByGates, buildUserMessage, parseJudgements, assemble } from "../ranking/src/pipeline.ts"

const ROOT = join(import.meta.dir, "..")
const SUPA = need("SUPABASE_URL")
const KEY = need("SUPABASE_SERVICE_KEY")
const OR = need("OPENROUTER_API_KEY")
const MODEL = process.env.RANK_MODEL || "anthropic/claude-haiku-4.5"
const supa = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }

function need(k: string): string {
  const v = process.env[k]
  if (!v) { console.error(`Falta ${k} no .env (raiz do repo).`); process.exit(1) }
  return v
}
async function sget(path: string) {
  const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: supa })
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`)
  return r.json()
}
async function spost(path: string, body: unknown, prefer = "return=minimal") {
  const r = await fetch(`${SUPA}/rest/v1/${path}`, { method: "POST", headers: { ...supa, Prefer: prefer }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`POST ${path} -> ${r.status} ${await r.text()}`)
  return r.status === 204 ? null : r.json()
}

const mapWork = (w?: string) => (w === "remote" ? "remote" : w === "hybrid" ? "hybrid" : w === "on-site" ? "onsite" : null)
const mapContract = (c?: string) => (c === "vacancy_legal_entity" ? "pj" : c === "vacancy_type_effective" ? "clt" : "unknown")

async function gupySearch(query: string, limit = 10): Promise<any[]> {
  const cli = join(ROOT, "portal-runner", "cli", "gupy-search", "src", "cli.ts")
  const proc = Bun.spawn(["bun", cli, "search", "-q", query, "--jobage", "14", "--limit", String(limit), "--format", "json"], { stdout: "pipe", stderr: "pipe" })
  const [out, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) return []
  try { return (JSON.parse(out).results ?? []) } catch { return [] }
}

async function main() {
  // 1. Perfil (o que você preencheu no onboarding).
  const tid = process.env.TENANT_ID
  const profRows = await sget(
    tid ? `profiles?tenant_id=eq.${tid}&select=*` : `profiles?completeness=gt.0&select=*&order=updated_at.desc&limit=1`,
  )
  if (!profRows.length) { console.error("Nenhum perfil preenchido encontrado. Faça o onboarding no painel primeiro."); process.exit(1) }
  const p = profRows[0]
  const tenant = p.tenant_id
  const profile = {
    targetRoles: p.target_roles || [],
    seniority: p.seniority || undefined,
    cities: p.cities || [],
    acceptsWorkModels: p.accepts_work_models || [],
    languages: p.languages || [],
    skills: p.skills || [],
    contractPreference: p.contract_preference || "any",
    summary: p.headline || undefined,
  }
  console.log(`Perfil: tenant ${tenant} | funções: ${profile.targetRoles.join(", ") || "—"}`)

  // 2. Busca na Gupy: QUICK_QUERY (env, separado por vírgula) sobrescreve as
  //    funções-alvo do perfil — útil pra testar sem editar o onboarding.
  const override = (process.env.QUICK_QUERY || "").split(",").map((s) => s.trim()).filter(Boolean)
  const queries = (override.length ? override : profile.targetRoles.length ? profile.targetRoles : ["automação"]).slice(0, 3)
  const seen = new Set<string>()
  const raw: any[] = []
  for (const q of queries) {
    const rs = await gupySearch(q, 10)
    for (const r of rs) { if (!seen.has(r.id)) { seen.add(r.id); raw.push(r) } }
    console.log(`  Gupy "${q}": ${rs.length} vagas`)
  }
  if (!raw.length) { console.error("A Gupy não retornou vagas. Tente outras funções-alvo."); process.exit(1) }

  // 3. Upsert em jobs (retorna os ids).
  const now = new Date().toISOString()
  const jobRows = raw.map((r) => ({
    source: "gupy", external_id: String(r.id), url: r.url, title: r.title,
    company: r.company ?? null, location: r.location ?? null,
    work_model: mapWork(r.workplaceType), description: null, posted_at: r.date ?? null,
    deadline: r.applicationDeadline ?? null, last_seen_at: now, raw: r,
  }))
  const upserted: any[] = await spost("jobs?on_conflict=source,external_id", jobRows, "resolution=merge-duplicates,return=representation")
  const idByExt = new Map(upserted.map((j) => [j.external_id, j.id]))
  console.log(`Vagas gravadas: ${upserted.length}`)

  // 4. Monta os Jobs para o ranking (com contractType vivo da Gupy → bônus de vínculo).
  const jobs = raw.map((r) => ({
    id: idByExt.get(String(r.id))!, source: "gupy", title: r.title, company: r.company ?? null,
    location: r.location ?? null, workModel: mapWork(r.workplaceType), description: null,
    contractType: mapContract(r.contractType), deadline: r.applicationDeadline ?? null,
  })).filter((j) => j.id)

  // 5. Gates → LLM → score.
  const { survivors, vetoed } = partitionByGates(jobs as any, profile as any)
  console.log(`Gates: ${survivors.length} passaram, ${vetoed.length} vetadas`)
  let results: any[] = []
  if (survivors.length) {
    const system = readFileSync(join(ROOT, "ranking", "prompts", "rank-system.md"), "utf-8")
    const user = buildUserMessage(profile as any, survivors)
    const llm = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OR}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    })
    if (!llm.ok) { console.error(`OpenRouter ${llm.status}: ${await llm.text()}`); process.exit(1) }
    const data = await llm.json()
    const content = data.choices?.[0]?.message?.content ?? "{}"
    results = assemble(survivors as any, profile as any, parseJudgements(content))
    console.log(`LLM ranqueou ${results.length} vagas (modelo ${MODEL})`)
  }

  // 6. Grava job_matches (vetadas + avaliadas). PostgREST exige que TODAS as
  //    linhas de um insert em lote tenham exatamente as mesmas chaves — por
  //    isso todo objeto abaixo declara o conjunto completo de campos, com
  //    null onde não se aplica (vetada não tem score; avaliada sempre tem).
  const rows: any[] = []
  for (const v of vetoed) rows.push({
    tenant_id: tenant, job_id: v.jobId, status: "ranked",
    score: null, score_technical: null, score_experience: null, score_behavioral: null, score_career: null,
    verdict: null, location_verdict: v.locationVerdict, language_verdict: v.languageVerdict,
    language_note: v.languageNote ?? null, strengths: [], gaps: v.gaps || [], model: null,
  })
  for (const r of results) rows.push({
    tenant_id: tenant, job_id: r.jobId, status: "ranked",
    score: r.overall ?? null, score_technical: r.scores?.technical ?? null, score_experience: r.scores?.experience ?? null,
    score_behavioral: r.scores?.behavioral ?? null, score_career: r.scores?.career ?? null,
    verdict: r.verdict ?? null, location_verdict: r.locationVerdict, language_verdict: r.languageVerdict,
    language_note: r.languageNote ?? null, strengths: r.strengths || [], gaps: r.gaps || [], model: MODEL,
  })
  if (rows.length) await spost("job_matches?on_conflict=tenant_id,job_id", rows, "resolution=merge-duplicates,return=minimal")

  const scored = results.filter((r) => r.scored).length
  console.log(`\nPRONTO. ${scored} vagas com score gravadas. Recarregue http://localhost:3000/vagas`)
}

main().catch((e) => { console.error(e); process.exit(1) })
