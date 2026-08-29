// Registro dos portais expostos pelo portal-runner.
//
// Só os 3 portais brasileiros de baixo/médio risco entram no produto comercial.
// LinkedIn e freehire ficam FORA de propósito (LinkedIn: ToS "personal use only").
//
// Cada portal declara exatamente quais campos do corpo da requisição podem virar
// flags do CLI. Um campo não declarado é REJEITADO no HTTP (mesma filosofia do
// CLI, que rejeita flag desconhecida em vez de ignorar): um filtro descartado em
// silêncio muda o resultado da busca.

import { join } from "node:path"

export type Portal = "gupy" | "catho" | "vagas"

export interface PortalDef {
  /** Caminho do cli.ts, relativo à raiz do portal-runner. */
  cliEntry: string
  /** Diretório de trabalho do processo (raiz do CLI). */
  cwd: string
  /** Campos do corpo aceitos em /search, além de nenhum obrigatório aqui
   *  (o próprio CLI valida "pelo menos um filtro"). */
  searchFields: Set<string>
  /** Campos extras aceitos em /detail além de `id`. */
  detailFields: Set<string>
  /** Intervalo mínimo entre execuções deste portal (rate limit central). */
  minIntervalMs: number
}

const ROOT = join(import.meta.dir, "..")
const cli = (name: string) => ({
  cliEntry: join(ROOT, "cli", name, "src", "cli.ts"),
  cwd: join(ROOT, "cli", name),
})

export const PORTALS: Record<Portal, PortalDef> = {
  gupy: {
    ...cli("gupy-search"),
    // Gupy é API pública JSON, sem auth: o mais barato e seguro. Intervalo curto.
    searchFields: new Set(["query", "location", "state", "remote", "jobage", "page", "limit"]),
    detailFields: new Set(),
    minIntervalMs: 1500,
  },
  catho: {
    ...cli("catho-search"),
    // Catho faz scraping de HTML. Intervalo conservador. browserHeaders é
    // escalonamento explícito (só quando o WAF bloquear o cliente honesto).
    searchFields: new Set(["query", "location", "jobage", "page", "limit", "browserHeaders"]),
    detailFields: new Set(["browserHeaders"]),
    minIntervalMs: 4000,
  },
  vagas: {
    ...cli("vagas-search"),
    // Vagas.com também é scraping de HTML. Sem --state nem --remote no portal.
    searchFields: new Set(["query", "location", "jobage", "page", "limit"]),
    detailFields: new Set(),
    minIntervalMs: 4000,
  },
}

export function isPortal(x: unknown): x is Portal {
  return typeof x === "string" && x in PORTALS
}

/** Mapeia uma chave do corpo para a flag longa do CLI. */
const FLAG_NAMES: Record<string, string> = {
  query: "--query",
  location: "--location",
  state: "--state",
  remote: "--remote",
  jobage: "--jobage",
  page: "--page",
  limit: "--limit",
  browserHeaders: "--browser-headers",
}

const REMOTE_MODES = new Set(["remote", "hybrid", "onsite", "on-site"])

export interface BuildResult {
  ok: true
  args: string[]
}
export interface BuildError {
  ok: false
  status: number
  error: string
  code: string
}

/** Constrói os argumentos do CLI de search a partir do corpo, validando cada
 *  campo. Só campos suportados pelo portal passam; qualquer outro é 400.
 *  --format json é sempre forçado (a API só fala JSON). */
export function buildSearchArgs(portal: Portal, body: Record<string, unknown>): BuildResult | BuildError {
  const def = PORTALS[portal]
  const args: string[] = []

  for (const [key, raw] of Object.entries(body)) {
    if (key === "portal") continue
    if (raw === undefined || raw === null) continue
    if (!def.searchFields.has(key)) {
      return { ok: false, status: 400, error: `campo '${key}' não é suportado pelo portal '${portal}'`, code: "UNSUPPORTED_FIELD" }
    }
    const v = validateField(key, raw)
    if (!v.ok) return v
    if (v.flagOnly) args.push(FLAG_NAMES[key])
    else args.push(FLAG_NAMES[key], v.value)
  }

  args.push("--format", "json")
  return { ok: true, args }
}

/** Constrói os argumentos do CLI de detail. Exige `id`. */
export function buildDetailArgs(portal: Portal, body: Record<string, unknown>): BuildResult | BuildError {
  const def = PORTALS[portal]
  const id = body.id
  if (typeof id !== "string" || id.trim() === "") {
    return { ok: false, status: 400, error: "detail exige 'id' (string: id do portal ou URL da vaga)", code: "NO_ID" }
  }
  const args: string[] = [id.trim()]

  for (const [key, raw] of Object.entries(body)) {
    if (key === "portal" || key === "id") continue
    if (raw === undefined || raw === null) continue
    if (!def.detailFields.has(key)) {
      return { ok: false, status: 400, error: `campo '${key}' não é suportado em detail no portal '${portal}'`, code: "UNSUPPORTED_FIELD" }
    }
    const v = validateField(key, raw)
    if (!v.ok) return v
    if (v.flagOnly) args.push(FLAG_NAMES[key])
    else args.push(FLAG_NAMES[key], v.value)
  }

  args.push("--format", "json")
  return { ok: true, args }
}

type FieldOk = { ok: true; flagOnly: boolean; value: string }
function validateField(key: string, raw: unknown): FieldOk | BuildError {
  switch (key) {
    case "browserHeaders":
      if (raw !== true) return { ok: false, status: 400, error: "browserHeaders deve ser true quando presente", code: "BAD_ARG" }
      return { ok: true, flagOnly: true, value: "" }
    case "jobage":
    case "page":
    case "limit": {
      const n = typeof raw === "number" ? raw : Number(raw)
      if (!Number.isInteger(n) || n < 1) return { ok: false, status: 400, error: `${key} deve ser inteiro >= 1`, code: "BAD_ARG" }
      return { ok: true, flagOnly: false, value: String(n) }
    }
    case "remote": {
      const s = String(raw).toLowerCase()
      if (!REMOTE_MODES.has(s)) return { ok: false, status: 400, error: "remote aceita remote|hybrid|onsite", code: "BAD_ARG" }
      return { ok: true, flagOnly: false, value: s }
    }
    case "query":
    case "location":
    case "state": {
      if (typeof raw !== "string" || raw.trim() === "") return { ok: false, status: 400, error: `${key} deve ser string não vazia`, code: "BAD_ARG" }
      return { ok: true, flagOnly: false, value: raw }
    }
    default:
      return { ok: false, status: 400, error: `campo desconhecido '${key}'`, code: "UNSUPPORTED_FIELD" }
  }
}
