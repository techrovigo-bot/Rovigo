// Tipos da geração de documentos (CV e carta). O framework original mantinha
// três fontes de verdade em markdown; aqui a fonte é uma só: o perfil do
// candidato no banco. Por isso ele precisa ser rico o bastante para ancorar
// tudo que um documento afirma.

/** Um emprego no histórico. É o que a auditoria de grounding usa como âncora:
 *  empresa, cargo e período que não estiverem aqui não podem aparecer no CV. */
export interface HistoryEntry {
  company: string
  role: string
  start: string // YYYY-MM
  end?: string | null // YYYY-MM, ou null/ausente = atual
  location?: string | null
  bullets: string[]
}

export interface DocProfile {
  fullName?: string | null
  headline?: string | null
  email?: string | null
  phone?: string | null
  targetRoles: string[]
  seniority?: string | null
  cities: string[]
  skills: string[]
  languages: { lang: string; level: string }[]
  history: HistoryEntry[]
}

export interface DocJob {
  id: string
  title: string
  company?: string | null
  location?: string | null
  description?: string | null
  url?: string | null
}

export type DocKind = "cv" | "cover_letter"

/** Saída do drafter: os dois documentos em markdown. */
export interface Draft {
  cv: string
  coverLetter: string
}

/** Veredicto de um claim na auditoria.
 *  - grounded:   ancorado no perfil, entra no documento
 *  - stretch:    reenquadramento defensável, entra MAS é sinalizado ao candidato
 *  - ungrounded: sem âncora, é REMOVIDO do documento (regra dura do framework) */
export type ClaimVerdict = "grounded" | "stretch" | "ungrounded"

export interface Claim {
  text: string
  verdict: ClaimVerdict
  /** Onde no perfil o claim se ancora (quando grounded). */
  source?: string
  /** Por que foi marcado como stretch/ungrounded. */
  reason?: string
  /** Qual documento continha o claim. */
  kind: DocKind
}

export interface GroundingReport {
  claims: Claim[]
  /** Trechos efetivamente removidos dos documentos. */
  removed: string[]
  /** Claims que ficaram, mas precisam de decisão do candidato. */
  stretches: Claim[]
  /** Violações duras achadas pela camada determinística (empresa/cargo/data
   *  que não existem no perfil). Nunca deveriam sair do LLM; se saírem, é sinal
   *  de que o prompt do drafter precisa de ajuste. */
  hardViolations: string[]
}
