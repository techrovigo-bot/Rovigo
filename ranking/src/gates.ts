// Estágio 1 do ranking: gates DETERMINÍSTICOS (zero token).
// Cortam o grosso das vagas antes de gastar LLM — a margem do produto.
// Regra de ouro herdada do framework: na dúvida, FLAG (o humano decide), nunca
// um FAIL silencioso. Só FAIL quando o descarte é seguro e óbvio.

import type { CandidateProfile, GateResult, Job, Verdict, WorkModel, LangLevel } from "./types.js"

// ---------------------------------------------------------------------------
// Normalização
// ---------------------------------------------------------------------------
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove acentos (diacríticos combinantes)
    .trim()
}

const REMOTE_HINTS = ["remoto", "remote", "home office", "home-office", "trabalho a distancia", "anywhere", "100% remoto"]

// ---------------------------------------------------------------------------
// Gate de LOCALIZAÇÃO — o maior eliminador de volume (a maioria das vagas é em
// outra cidade).
// ---------------------------------------------------------------------------
export function locationGate(job: Job, p: CandidateProfile): { verdict: Verdict; reason?: string } {
  const text = normalize([job.location ?? "", job.title ?? "", job.description ?? ""].join(" "))
  const jobIsRemote = job.workModel === "remote" || REMOTE_HINTS.some((h) => text.includes(h))
  const acceptsRemote = p.acceptsWorkModels.includes("remote")

  // Remoto que o candidato aceita: PASS direto.
  if (jobIsRemote && acceptsRemote) return { verdict: "pass" }

  // Presencial/híbrido: precisa bater cidade.
  const cityMatch = p.cities.some((c) => {
    const nc = normalize(c)
    return nc.length > 0 && (text.includes(nc) || (job.location ? normalize(job.location).includes(nc) : false))
  })

  const model: WorkModel | null = job.workModel ?? null

  if (cityMatch) {
    // Cidade aceita. Se o modelo é aceito (ou desconhecido), PASS.
    if (!model || p.acceptsWorkModels.includes(model)) return { verdict: "pass" }
    return { verdict: "flag", reason: `modelo ${model} não está entre os aceitos, mas a cidade bate` }
  }

  // Remoto que o candidato NÃO aceita.
  if (jobIsRemote && !acceptsRemote) return { verdict: "flag", reason: "vaga remota, mas candidato não marcou remoto" }

  // Sem cidade legível e sem sinal de remoto: ambíguo → FLAG (não descarta).
  if (!job.location && !jobIsRemote) return { verdict: "flag", reason: "localização não declarada" }

  // Presencial/híbrido em cidade fora da lista do candidato: FAIL (deal-breaker
  // clássico — exige mudança/deslocamento).
  return { verdict: "fail", reason: "presencial/híbrido fora das cidades aceitas" }
}

// ---------------------------------------------------------------------------
// Gate de IDIOMA — conservador. Só FAIL quando a vaga EXIGE (não "desejável")
// um idioma que o candidato não declara de forma alguma. Nível acima do
// declarado vira FLAG. O estágio LLM refina o resto.
// ---------------------------------------------------------------------------
const LEVEL_ORDER: LangLevel[] = ["reading", "basic", "conversational", "intermediate", "advanced", "fluent", "native"]
function levelRank(l: LangLevel): number {
  return LEVEL_ORDER.indexOf(l)
}

// Frases que indicam EXIGÊNCIA de nível alto, por idioma.
const REQUIRE_PATTERNS: { lang: string; level: LangLevel; re: RegExp }[] = [
  { lang: "ingles", level: "fluent", re: /ingles\s+(fluente|avancad[oa]|nativ[oa])|fluent\s+english|advanced\s+english|english\s+(fluency|fluent|proficiency)|proficien\w+\s+in\s+english|ingles\s+nivel\s+(avancado|fluente)/ },
  { lang: "espanhol", level: "fluent", re: /espanhol\s+(fluente|avancad[oa]|nativ[oa])|fluent\s+spanish|advanced\s+spanish|espanol\s+(fluido|avanzado)/ },
]

// Contexto que rebaixa a exigência para "desejável" (não é job condition).
const DESIRABLE_HINTS = ["desejavel", "diferencial", "sera um plus", "nice to have", "plus", "vantagem", "bonus"]

export function languageGate(job: Job, p: CandidateProfile): { verdict: Verdict; note?: string } {
  const text = normalize([job.title ?? "", job.description ?? ""].join(" "))
  if (!text) return { verdict: "pass" }

  for (const pat of REQUIRE_PATTERNS) {
    const m = pat.re.exec(text)
    if (!m) continue

    // A exigência é apenas "desejável"? Olha a janela ao redor do match.
    const idx = m.index
    const window = text.slice(Math.max(0, idx - 60), idx + 60)
    const desirable = DESIRABLE_HINTS.some((h) => window.includes(h))
    if (desirable) continue // não é condição da vaga

    const declared = p.languages.find((l) => normalize(l.lang) === pat.lang)
    const langLabel = pat.lang === "ingles" ? "inglês" : "espanhol"

    if (!declared) {
      return { verdict: "fail", note: `vaga exige ${langLabel} (nível alto) e o perfil não declara ${langLabel}` }
    }
    if (levelRank(declared.level) < levelRank(pat.level)) {
      return { verdict: "flag", note: `vaga pede ${langLabel} ~${pat.level}; perfil declara ${declared.level}` }
    }
  }
  return { verdict: "pass" }
}

// ---------------------------------------------------------------------------
// Gate de SENIORIDADE — só FAIL no incompatível óbvio: estágio/trainee para
// quem já é pleno ou acima (estágio exige vínculo de estudante). O resto é
// pontuado pelo LLM, não vetado.
// ---------------------------------------------------------------------------
const INTERN_HINTS = ["estagio", "estagiario", "estagiaria", "trainee", "aprendiz", "jovem aprendiz", "internship", "intern "]
const SENIOR_LEVELS = ["pleno", "senior", "sênior", "especialista", "principal", "lead", "gerente", "coordenador", "arquiteto"]

export function seniorityGate(job: Job, p: CandidateProfile): { verdict: Verdict; reason?: string } {
  const sen = p.seniority ? normalize(p.seniority) : ""
  const candidateIsSenior = SENIOR_LEVELS.some((s) => sen.includes(normalize(s)))
  if (!candidateIsSenior) return { verdict: "pass" } // sem sinal forte, não veta

  const title = normalize(job.title ?? "")
  const isIntern = INTERN_HINTS.some((h) => title.includes(h))
  if (isIntern) return { verdict: "fail", reason: "vaga de estágio/trainee incompatível com perfil pleno+" }
  return { verdict: "pass" }
}

// ---------------------------------------------------------------------------
// Compõe os três gates.
// ---------------------------------------------------------------------------
export function runGates(job: Job, p: CandidateProfile): GateResult {
  const loc = locationGate(job, p)
  const lang = languageGate(job, p)
  const sen = seniorityGate(job, p)

  const failed =
    loc.verdict === "fail" ? loc.reason :
    lang.verdict === "fail" ? lang.note :
    sen.verdict === "fail" ? sen.reason :
    undefined

  return {
    passed: failed === undefined,
    location: loc.verdict,
    language: lang.verdict,
    languageNote: lang.note,
    seniority: sen.verdict,
    reason: failed,
  }
}
