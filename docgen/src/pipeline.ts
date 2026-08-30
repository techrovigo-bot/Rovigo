// Pipeline de geração. Como no rank-service, este pacote NÃO chama LLM: monta
// prompts e valida saídas. Quem chama o modelo é o n8n. Isso mantém tudo
// testável offline e sem chave de API dentro do container.

import type { Claim, DocProfile, DocJob, Draft, GroundingReport, HistoryEntry } from "./types.js"
import { hardCheck, stripUngrounded } from "./grounding.js"

// --- helpers de parsing tolerante -------------------------------------------

/** LLMs às vezes devolvem o JSON dentro de cerca de código, ou com prosa em
 *  volta. Extrai o objeto JSON de forma tolerante, como o parseJudgements do
 *  ranking faz. */
export function parseJson(raw: string): Record<string, unknown> {
  const cleaned = String(raw ?? "")
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim()
  try {
    const v = JSON.parse(cleaned)
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  } catch {
    // última tentativa: recorta do primeiro { ao último }
    const s = cleaned.indexOf("{")
    const e = cleaned.lastIndexOf("}")
    if (s >= 0 && e > s) {
      try {
        const v = JSON.parse(cleaned.slice(s, e + 1))
        return v && typeof v === "object" ? (v as Record<string, unknown>) : {}
      } catch {
        return {}
      }
    }
    return {}
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")
const strArray = (v: unknown, max = 12): string[] =>
  Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, max) : []

/** Normaliza YYYY-MM. Aceita "2024", "2024-3", "03/2024". Devolve "" se não der. */
export function normMonth(v: unknown): string {
  const s = str(v)
  if (!s) return ""
  let m = s.match(/^(\d{4})-(\d{1,2})$/)
  if (m) return `${m[1]}-${String(Number(m[2])).padStart(2, "0")}`
  m = s.match(/^(\d{1,2})\/(\d{4})$/)
  if (m) return `${m[2]}-${String(Number(m[1])).padStart(2, "0")}`
  m = s.match(/^(\d{4})$/)
  if (m) return `${m[1]}-01`
  return ""
}

// --- extração de histórico ---------------------------------------------------

export interface ExtractResult {
  history: HistoryEntry[]
  skills: string[]
  warnings: string[]
}

/** Valida e normaliza a extração do LLM. Entradas sem empresa OU sem cargo são
 *  descartadas com aviso: um emprego pela metade não serve de âncora. */
export function assembleExtract(raw: string): ExtractResult {
  const obj = parseJson(raw)
  const warnings = strArray(obj.warnings)
  const history: HistoryEntry[] = []

  const rawHistory = Array.isArray(obj.history) ? obj.history : []
  for (const e of rawHistory) {
    if (!e || typeof e !== "object") continue
    const r = e as Record<string, unknown>
    const company = str(r.company)
    const role = str(r.role)
    const start = normMonth(r.start)
    if (!company || !role) {
      warnings.push(`entrada descartada por falta de empresa ou cargo: ${JSON.stringify(r).slice(0, 120)}`)
      continue
    }
    if (!start) warnings.push(`data de início ilegível em "${company} — ${role}"`)
    const endRaw = r.end
    const end = endRaw === null || endRaw === undefined || str(endRaw) === "" ? null : normMonth(endRaw) || null
    history.push({
      company,
      role,
      start: start || "1970-01",
      end,
      location: str(r.location) || null,
      bullets: strArray(r.bullets, 6),
    })
  }

  return { history, skills: strArray(obj.skills, 40), warnings }
}

// --- drafter ------------------------------------------------------------------

function profileBlock(p: DocProfile): string {
  const lines: string[] = ["## PERFIL DO CANDIDATO (fonte de verdade)"]
  if (p.fullName) lines.push(`Nome: ${p.fullName}`)
  if (p.headline) lines.push(`Headline: ${p.headline}`)
  if (p.email) lines.push(`E-mail: ${p.email}`)
  if (p.phone) lines.push(`Telefone: ${p.phone}`)
  if (p.seniority) lines.push(`Senioridade: ${p.seniority}`)
  if (p.cities.length) lines.push(`Cidades: ${p.cities.join(", ")}`)
  if (p.targetRoles.length) lines.push(`Funções-alvo: ${p.targetRoles.join(", ")}`)
  if (p.skills.length) lines.push(`Skills: ${p.skills.join(", ")}`)
  if (p.languages.length) lines.push(`Idiomas: ${p.languages.map((l) => `${l.lang} (${l.level})`).join(", ")}`)

  lines.push("", "### Histórico profissional")
  for (const h of p.history) {
    const period = `${h.start} – ${h.end ?? "atual"}`
    lines.push(`- **${h.role}** — ${h.company} (${period}${h.location ? `, ${h.location}` : ""})`)
    for (const b of h.bullets) lines.push(`  - ${b}`)
  }
  return lines.join("\n")
}

function jobBlock(j: DocJob, maxDesc: number): string {
  const desc = (j.description ?? "").slice(0, maxDesc)
  return [
    "## VAGA",
    `Título: ${j.title}`,
    j.company ? `Empresa: ${j.company}` : "",
    j.location ? `Local: ${j.location}` : "",
    "",
    "### Descrição",
    desc || "(sem descrição disponível)",
  ]
    .filter(Boolean)
    .join("\n")
}

export function buildDraftMessage(p: DocProfile, j: DocJob): string {
  const maxDesc = Number(process.env.DOCGEN_DESC_MAX ?? 6000)
  return `${profileBlock(p)}\n\n${jobBlock(j, maxDesc)}`
}

export function assembleDraft(raw: string): Draft {
  const obj = parseJson(raw)
  return { cv: str(obj.cv), coverLetter: str(obj.coverLetter) }
}

// --- reviewer + auditoria -----------------------------------------------------

export function buildReviewMessage(p: DocProfile, j: DocJob, d: Draft): string {
  const maxDesc = Number(process.env.DOCGEN_DESC_MAX ?? 6000)
  return [
    profileBlock(p),
    "",
    jobBlock(j, maxDesc),
    "",
    "## DOCUMENTO: CV",
    d.cv,
    "",
    "## DOCUMENTO: CARTA",
    d.coverLetter,
  ].join("\n")
}

function parseClaims(obj: Record<string, unknown>): Claim[] {
  const raw = Array.isArray(obj.claims) ? obj.claims : []
  const out: Claim[] = []
  for (const c of raw) {
    if (!c || typeof c !== "object") continue
    const r = c as Record<string, unknown>
    const text = str(r.text)
    if (!text) continue
    const v = str(r.verdict)
    const verdict = v === "grounded" || v === "stretch" || v === "ungrounded" ? v : "ungrounded"
    const kind = str(r.kind) === "cover_letter" ? "cover_letter" : "cv"
    out.push({ text, verdict, kind, source: str(r.source) || undefined, reason: str(r.reason) || undefined })
  }
  return out
}

export interface AuditResult {
  report: GroundingReport
  clean: Draft
}

/**
 * Consolida as duas camadas e aplica a regra dura: claim `ungrounded` sai do
 * documento. `stretch` fica, mas vai no relatório para o candidato decidir.
 *
 * A camada determinística roda SEMPRE, mesmo que o reviewer tenha aprovado
 * tudo — ela é a rede que não depende de um LLM cooperar.
 */
export function audit(p: DocProfile, draft: Draft, llmReview: string): AuditResult {
  const obj = parseJson(llmReview)
  const claims = parseClaims(obj)

  const hardCv = hardCheck(draft.cv, p)
  // Na carta, citar uma titulação costuma ser reconhecer a lacuna, não
  // reivindicá-la; a checagem literal apagaria a honestidade. Ver HardCheckOptions.
  const hardCl = hardCheck(draft.coverLetter, p, { checkCredentials: false })
  const hardViolations = [...hardCv.violations, ...hardCl.violations]

  // Trechos a remover: os claims ungrounded do reviewer + os termos que a
  // camada determinística flagrou (número/empresa sem âncora).
  const ungroundedTexts = claims.filter((c) => c.verdict === "ungrounded").map((c) => c.text)
  const hardTermsCv = [...hardCv.unknownCompanies, ...hardCv.unknownNumbers, ...hardCv.unknownCredentials]
  const hardTermsCl = [...hardCl.unknownCompanies, ...hardCl.unknownNumbers, ...hardCl.unknownCredentials]

  const cvOut = stripUngrounded(draft.cv, [
    ...claims.filter((c) => c.verdict === "ungrounded" && c.kind === "cv").map((c) => c.text),
    ...hardTermsCv,
  ])
  const clOut = stripUngrounded(draft.coverLetter, [
    ...claims.filter((c) => c.verdict === "ungrounded" && c.kind === "cover_letter").map((c) => c.text),
    ...hardTermsCl,
  ])

  return {
    report: {
      claims,
      removed: [...cvOut.removed, ...clOut.removed],
      stretches: claims.filter((c) => c.verdict === "stretch"),
      hardViolations,
    },
    clean: { cv: cvOut.text, coverLetter: clOut.text },
  }
}
