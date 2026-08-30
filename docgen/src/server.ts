// docgen — HTTP fino sobre o pacote de geração de documentos, no mesmo padrão
// do rank-service: o serviço prepara prompts e valida saídas, o n8n chama o LLM.
//
//   GET  /health
//   POST /prepare-extract  {rawText}                  -> {system, user}
//   POST /assemble-extract {llm}                      -> {history, skills, warnings}
//   POST /prepare-draft    {profile, job}             -> {system, user}
//   POST /assemble-draft   {llm}                      -> {cv, coverLetter}
//   POST /prepare-review   {profile, job, draft}      -> {system, user}
//   POST /audit            {profile, draft, llmReview}-> {report, clean}
//   POST /render           {profile, draft}           -> {cvHtml, coverHtml}
//
// Auth: Authorization: Bearer <DOCGEN_SERVICE_TOKEN>. Sem token, POST -> 503.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { DocProfile, DocJob, Draft } from "./types.js"
import {
  assembleExtract,
  buildDraftMessage,
  assembleDraft,
  buildReviewMessage,
  audit,
} from "./pipeline.js"
import { renderCv, renderCoverLetter } from "./render.js"

const TOKEN = process.env.DOCGEN_SERVICE_TOKEN ?? ""
const PORT = Number(process.env.PORT ?? 8100)

const p = (f: string) => readFileSync(join(import.meta.dir, "..", "prompts", f), "utf-8")
const SYS_EXTRACT = p("extract-system.md")
const SYS_DRAFT = p("draft-system.md")
const SYS_REVIEW = p("review-system.md")

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}
function authorized(req: Request): boolean {
  if (!TOKEN) return false
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)
  return m !== null && m[1] === TOKEN
}
async function body(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json()
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const ROUTES = new Set([
  "/prepare-extract",
  "/assemble-extract",
  "/prepare-draft",
  "/assemble-draft",
  "/prepare-review",
  "/audit",
  "/render",
])

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", authConfigured: TOKEN !== "" })
    }

    if (req.method === "POST" && ROUTES.has(url.pathname)) {
      if (!TOKEN) return json({ error: "DOCGEN_SERVICE_TOKEN não configurado", code: "AUTH_NOT_CONFIGURED" }, 503)
      if (!authorized(req)) return json({ error: "não autorizado", code: "UNAUTHORIZED" }, 401)

      const b = await body(req)
      if (!b) return json({ error: "corpo JSON inválido", code: "BAD_BODY" }, 400)

      // --- extração -------------------------------------------------------
      if (url.pathname === "/prepare-extract") {
        const rawText = typeof b.rawText === "string" ? b.rawText : ""
        if (!rawText.trim()) return json({ error: "campo 'rawText' obrigatório", code: "NO_TEXT" }, 400)
        const max = Number(process.env.DOCGEN_CV_MAX ?? 24000)
        return json({ system: SYS_EXTRACT, user: rawText.slice(0, max) })
      }
      if (url.pathname === "/assemble-extract") {
        const llm = b.llm
        return json(assembleExtract(typeof llm === "string" ? llm : JSON.stringify(llm ?? {})))
      }

      // --- daqui pra baixo tudo exige perfil --------------------------------
      const profile = b.profile as DocProfile | undefined
      if (url.pathname !== "/assemble-draft" && !profile) {
        return json({ error: "campo 'profile' obrigatório", code: "NO_PROFILE" }, 400)
      }

      if (url.pathname === "/prepare-draft") {
        const job = b.job as DocJob | undefined
        if (!job) return json({ error: "campo 'job' obrigatório", code: "NO_JOB" }, 400)
        if (!profile!.history?.length) {
          return json({ error: "perfil sem histórico profissional", code: "NO_HISTORY" }, 400)
        }
        return json({ system: SYS_DRAFT, user: buildDraftMessage(profile!, job) })
      }

      if (url.pathname === "/assemble-draft") {
        const llm = b.llm
        return json(assembleDraft(typeof llm === "string" ? llm : JSON.stringify(llm ?? {})))
      }

      if (url.pathname === "/prepare-review") {
        const job = b.job as DocJob | undefined
        const draft = b.draft as Draft | undefined
        if (!job || !draft) return json({ error: "campos 'job' e 'draft' obrigatórios", code: "BAD_INPUT" }, 400)
        return json({ system: SYS_REVIEW, user: buildReviewMessage(profile!, job, draft) })
      }

      if (url.pathname === "/audit") {
        const draft = b.draft as Draft | undefined
        if (!draft) return json({ error: "campo 'draft' obrigatório", code: "NO_DRAFT" }, 400)
        const llmReview = b.llmReview
        return json(audit(profile!, draft, typeof llmReview === "string" ? llmReview : JSON.stringify(llmReview ?? {})))
      }

      // /render
      const draft = b.draft as Draft | undefined
      if (!draft) return json({ error: "campo 'draft' obrigatório", code: "NO_DRAFT" }, 400)
      return json({
        cvHtml: renderCv(profile!, draft.cv),
        coverHtml: renderCoverLetter(profile!, draft.coverLetter),
      })
    }

    return json({ error: "not found", code: "NOT_FOUND" }, 404)
  },
})

console.log(`docgen ouvindo em :${server.port} — auth ${TOKEN ? "on" : "OFF (POST bloqueado)"}`)
