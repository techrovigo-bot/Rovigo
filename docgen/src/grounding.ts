// Auditoria de grounding — camada determinística.
//
// É o diferencial anti-alucinação do framework, portado para o SaaS. A regra
// herdada é dura: um claim sem âncora no perfil é REMOVIDO do documento, não
// sinalizado. A auditoria não consegue distinguir uma fabricação de um fato
// real que o candidato nunca registrou — e essa rigidez é proposital: o custo
// de um CV com experiência inventada aparece na entrevista, tarde demais.
//
// Esta camada pega o que é verificável por comparação literal (empresa, cargo,
// período, números). O julgamento semântico fica com o reviewer LLM.

import type { DocProfile, HistoryEntry } from "./types.js"

/** Normaliza para comparação: minúsculas, sem acento, sem pontuação, espaços
 *  colapsados. "Preâmbulo Tech." e "preambulo tech" viram a mesma string. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Todo texto do perfil que pode servir de âncora, já normalizado. */
export function anchorText(p: DocProfile): string {
  const parts: string[] = [
    p.fullName ?? "",
    p.headline ?? "",
    ...p.targetRoles,
    ...p.skills,
    ...p.cities,
    p.seniority ?? "",
    ...p.languages.map((l) => `${l.lang} ${l.level}`),
  ]
  for (const h of p.history) {
    parts.push(h.company, h.role, h.location ?? "", ...h.bullets)
  }
  return norm(parts.join(" \n "))
}

/** Empresas e cargos declarados, normalizados. */
export function knownCompanies(p: DocProfile): Set<string> {
  return new Set(p.history.map((h) => norm(h.company)).filter(Boolean))
}
export function knownRoles(p: DocProfile): Set<string> {
  return new Set(p.history.map((h) => norm(h.role)).filter(Boolean))
}

/** Anos que aparecem no histórico (início e fim de cada emprego). Um ano citado
 *  no documento que não esteja em nenhum período declarado é suspeito. */
export function knownYears(p: DocProfile): Set<string> {
  const years = new Set<string>()
  for (const h of p.history) {
    const s = Number((h.start ?? "").slice(0, 4))
    const e = h.end ? Number(h.end.slice(0, 4)) : new Date().getUTCFullYear()
    if (!Number.isFinite(s)) continue
    const last = Number.isFinite(e) ? e : s
    for (let y = s; y <= last; y++) years.add(String(y))
  }
  return years
}

/** Todos os números que aparecem no perfil (métricas dos bullets, etc.).
 *  Serve para barrar inflação: "46 pessoas" no perfil não pode virar "60". */
export function knownNumbers(p: DocProfile): Set<string> {
  const nums = new Set<string>()
  const scan = (t: string) => {
    for (const m of t.matchAll(/\d[\d.,]*/g)) nums.add(m[0].replace(/[.,]$/, ""))
  }
  for (const h of p.history) {
    scan(h.bullets.join(" "))
    scan(h.start ?? "")
    scan(h.end ?? "")
  }
  scan(p.headline ?? "")
  scan(p.skills.join(" "))
  return nums
}

/** Números que não precisam de âncora: anos conhecidos e valores triviais
 *  (ordinais, percentuais de uso comum em prosa). Mantido curto de propósito —
 *  cada exceção aqui é uma brecha por onde uma métrica inventada pode passar. */
function numberIsBenign(raw: string, years: Set<string>): boolean {
  const n = raw.replace(/[.,]/g, "")
  if (years.has(raw)) return true
  if (/^(19|20)\d{2}$/.test(raw)) return true // ano plausível
  return Number(n) <= 12 // "3 áreas", "5 anos" — pequenos demais para serem métrica de impacto
}

/** Titulações e certificações. São o vetor clássico de fabricação: não têm
 *  número nem nome de empresa, então escapariam das outras checagens. A regra é
 *  simples — se o documento cita uma titulação que não aparece em lugar nenhum
 *  do perfil, ela não pode ficar. */
const CREDENTIAL_TERMS = [
  "phd",
  "ph d",
  "doutorado",
  "doutor",
  "mestrado",
  "mestre",
  "mba",
  "pos graduacao",
  "posgraduacao",
  "especializacao",
  "bacharelado",
  "bacharel",
  "licenciatura",
  "tecnologo",
  "certificacao",
  "certified",
  "certificado",
]

export interface HardCheck {
  violations: string[]
  /** Termos suspeitos por categoria, para o relatório. */
  unknownCompanies: string[]
  unknownNumbers: string[]
  unknownCredentials: string[]
}

/**
 * Confere um documento gerado contra o perfil.
 *
 * Empresas: procura no texto do documento qualquer nome próprio em posição de
 * empregador. Como identificar empregador em prosa livre é frágil, a checagem
 * roda ao contrário e de forma conservadora: toda sequência capitalizada
 * multi-palavra que *pareça* nome de empresa e não esteja no perfil vira
 * violação. Falso positivo aqui custa uma revisão; falso negativo custa um CV
 * mentiroso, então erramos para o lado barulhento.
 */
export interface HardCheckOptions {
  /** Checar titulações. Vale para o CV, onde citar um diploma é afirmá-lo.
   *  NÃO vale para a carta: lá, mencionar uma credencial normalmente é
   *  reconhecer que não se tem ("a vaga pede PhD; não tenho"), e apagar essa
   *  frase destruiria justamente a honestidade sobre lacunas que queremos.
   *  Na carta, quem julga isso é o reviewer, que entende o contexto. */
  checkCredentials?: boolean
}

export function hardCheck(doc: string, p: DocProfile, opts: HardCheckOptions = {}): HardCheck {
  const checkCredentials = opts.checkCredentials !== false
  const violations: string[] = []
  const anchors = anchorText(p)
  const companies = knownCompanies(p)
  const years = knownYears(p)
  const numbers = knownNumbers(p)

  // --- empresas -------------------------------------------------------------
  // Detecta nome próprio seguido de marcador societário/corporativo. Tentar
  // inferir "isto é um empregador" de prosa livre sem esse marcador gera ruído
  // demais para ser acionável; o julgamento semântico fica com o reviewer LLM.
  // O que esta camada garante é que nenhum nome de empresa *explícito* passe
  // sem estar no perfil.
  const unknownCompanies: string[] = []
  const companyRe =
    /\b((?:[A-ZÀ-Þ][\wÀ-ÿ&-]*\s+){0,3}[A-ZÀ-Þ][\wÀ-ÿ&-]*)\s+(S\.?A\.?|Ltda\.?|LLC|GmbH|Inc\.?|Corp\.?|Corporation|Tecnologia|Solutions|Consultoria|University|Universidade|Faculdade|Instituto)\b/g
  for (const m of doc.matchAll(companyRe)) {
    const full = m[0].trim()
    const name = norm(m[1])
    if (!name) continue
    if (companies.has(name)) continue
    if (anchors.includes(name)) continue // aparece em algum lugar do perfil
    violations.push(`empresa não declarada no perfil: "${full}"`)
    unknownCompanies.push(full)
  }

  // --- anos -----------------------------------------------------------------
  for (const m of doc.matchAll(/\b(19|20)\d{2}\b/g)) {
    if (!years.has(m[0])) {
      violations.push(`ano fora dos períodos declarados: ${m[0]}`)
    }
  }

  // --- números / métricas ---------------------------------------------------
  const unknownNumbers: string[] = []
  for (const m of doc.matchAll(/\d[\d.,]*\s*%?/g)) {
    const raw = m[0].trim().replace(/\s*%$/, "").replace(/[.,]$/, "")
    if (!raw) continue
    if (numberIsBenign(raw, years)) continue
    if (numbers.has(raw)) continue
    violations.push(`número sem âncora no perfil: "${m[0].trim()}"`)
    unknownNumbers.push(raw)
  }

  // --- titulações e certificações -------------------------------------------
  const unknownCredentials: string[] = []
  if (checkCredentials) {
    const docNorm = norm(doc)
    for (const term of CREDENTIAL_TERMS) {
      if (!docNorm.includes(term)) continue
      if (anchors.includes(term)) continue
      violations.push(`titulação/certificação não declarada no perfil: "${term}"`)
      unknownCredentials.push(term)
    }
  }

  return { violations, unknownCompanies, unknownNumbers, unknownCredentials }
}

/**
 * Remove do markdown as linhas que contêm um trecho não-ancorado. Opera por
 * linha (bullet ou parágrafo) porque remover só a frase deixaria o texto
 * quebrado; o framework original também descartava o bullet inteiro.
 */
export function stripUngrounded(doc: string, offending: string[]): { text: string; removed: string[] } {
  const terms = offending.map((o) => o.trim()).filter(Boolean)
  if (!terms.length) return { text: doc, removed: [] }
  const removed: string[] = []
  const kept = doc
    .split("\n")
    .filter((line) => {
      const lineNorm = norm(line)
      // Compara também na forma normalizada: os termos de titulação vêm
      // normalizados ("phd") e não bateriam com o texto cru ("PhD").
      const hit = terms.some((t) => line.includes(t) || lineNorm.includes(norm(t)))
      if (hit) removed.push(line.trim())
      return !hit
    })
    .join("\n")
  return { text: kept, removed }
}
