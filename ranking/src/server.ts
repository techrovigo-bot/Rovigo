// rank-service — HTTP fino sobre o pacote de ranking, para o n8n chamar sem
// duplicar a lógica (gates/score) em nós Code (evita drift do framework).
//
//   GET  /health
//   POST /prepare  {profile, jobs}            -> {system, user, survivors, vetoed}
//   POST /assemble {profile, survivors, llm}  -> {results}
//
// O /prepare roda os gates (estágio 1) e monta a mensagem do LLM; o n8n chama o
// modelo com {system,user}; o /assemble parseia a saída e aplica o score.
// Auth: Authorization: Bearer <RANK_SERVICE_TOKEN>. Sem token, POST -> 503.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { CandidateProfile, Job } from "./types.js"
import { partitionByGates, buildUserMessage, parseJudgements, assemble } from "./pipeline.js"

const TOKEN = process.env.RANK_SERVICE_TOKEN ?? ""
const PORT = Number(process.env.PORT ?? 8090)
const SYSTEM = readFileSync(join(import.meta.dir, "..", "prompts", "rank-system.md"), "utf-8")

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}
function authorized(req: Request): boolean {
  if (!TOKEN) return false
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)
  return m !== null && m[1] === TOKEN
}
async function body(req: Request): Promise<Record<string, unknown> | null> {
  try { const b = await req.json(); return b && typeof b === "object" ? (b as Record<string, unknown>) : null }
  catch { return null }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", authConfigured: TOKEN !== "" })
    }

    if (req.method === "POST" && (url.pathname === "/prepare" || url.pathname === "/assemble")) {
      if (!TOKEN) return json({ error: "RANK_SERVICE_TOKEN não configurado", code: "AUTH_NOT_CONFIGURED" }, 503)
      if (!authorized(req)) return json({ error: "não autorizado", code: "UNAUTHORIZED" }, 401)

      const b = await body(req)
      if (!b) return json({ error: "corpo JSON inválido", code: "BAD_BODY" }, 400)
      const profile = b.profile as CandidateProfile | undefined
      if (!profile) return json({ error: "campo 'profile' obrigatório", code: "NO_PROFILE" }, 400)

      if (url.pathname === "/prepare") {
        const jobs = (b.jobs as Job[]) ?? []
        const { survivors, vetoed } = partitionByGates(jobs, profile)
        const user = survivors.length ? buildUserMessage(profile, survivors) : ""
        return json({ system: SYSTEM, user, survivors, vetoed })
      }

      // /assemble
      const survivors = (b.survivors as Job[]) ?? []
      const llm = b.llm
      const judgements = parseJudgements(typeof llm === "string" ? llm : JSON.stringify(llm ?? {}))
      const results = assemble(survivors, profile, judgements)
      return json({ results })
    }

    return json({ error: "not found", code: "NOT_FOUND" }, 404)
  },
})

console.log(`rank-service ouvindo em :${server.port} — auth ${TOKEN ? "on" : "OFF (POST bloqueado)"}`)
