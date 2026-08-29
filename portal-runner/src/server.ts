// portal-runner — serviço HTTP fino que o n8n chama para buscar vagas nos portais
// brasileiros, envolvendo os CLIs bun e preservando o contrato JSON.
//
// Endpoints:
//   GET  /health            aberto; status e portais habilitados
//   POST /search  {portal, query?, location?, state?, remote?, jobage?, page?, limit?, browserHeaders?}
//   POST /detail  {portal, id, browserHeaders?}
//
// Autenticação: Authorization: Bearer <PORTAL_RUNNER_TOKEN> nos endpoints POST.
// Sem token configurado, os POST respondem 503 (fail closed); /health continua.

import { PORTALS, isPortal, buildSearchArgs, buildDetailArgs, type Portal } from "./portals.js"
import { PortalLimiter } from "./rateLimit.js"
import { runCli } from "./runner.js"

const TOKEN = process.env.PORTAL_RUNNER_TOKEN ?? ""
const PORT = Number(process.env.PORT ?? 8080)
// Kill-switch por env, além do feature_flags no banco (checado pelo n8n antes de chamar).
const DISABLED = new Set(
  (process.env.PORTAL_RUNNER_DISABLED ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
)

const limiter = new PortalLimiter()

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function authorized(req: Request): boolean {
  if (!TOKEN) return false
  const h = req.headers.get("authorization") ?? ""
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m !== null && m[1] === TOKEN
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json()
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function handlePortalCall(
  req: Request,
  kind: "search" | "detail",
): Promise<Response> {
  if (!TOKEN) return json({ error: "PORTAL_RUNNER_TOKEN não configurado", code: "AUTH_NOT_CONFIGURED" }, 503)
  if (!authorized(req)) return json({ error: "não autorizado", code: "UNAUTHORIZED" }, 401)

  const body = await readBody(req)
  if (!body) return json({ error: "corpo JSON inválido", code: "BAD_BODY" }, 400)

  const portal = body.portal
  if (!isPortal(portal)) return json({ error: `portal inválido; use ${Object.keys(PORTALS).join(" | ")}`, code: "BAD_PORTAL" }, 400)
  if (DISABLED.has(portal)) return json({ error: `portal '${portal}' desabilitado`, code: "PORTAL_DISABLED" }, 503)

  const built = kind === "search" ? buildSearchArgs(portal, body) : buildDetailArgs(portal, body)
  if (!built.ok) return json({ error: built.error, code: built.code }, built.status)

  try {
    const result = await limiter.run(portal as Portal, PORTALS[portal as Portal].minIntervalMs, () =>
      runCli(portal as Portal, kind, built.args),
    )
    if (result.ok) return json(result.data, 200)
    return json(result.body, result.status)
  } catch (e) {
    const err = e as Error & { status?: number; code?: string }
    if (err.status === 429) return json({ error: err.message, code: err.code ?? "RATE_LIMITED" }, 429)
    return json({ error: err.message ?? "erro interno", code: "INTERNAL_ERROR" }, 500)
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === "GET" && url.pathname === "/health") {
      const portals = Object.fromEntries(
        (Object.keys(PORTALS) as Portal[]).map((p) => [p, !DISABLED.has(p)]),
      )
      return json({ status: "ok", authConfigured: TOKEN !== "", portals })
    }

    if (req.method === "POST" && url.pathname === "/search") return handlePortalCall(req, "search")
    if (req.method === "POST" && url.pathname === "/detail") return handlePortalCall(req, "detail")

    return json({ error: "not found", code: "NOT_FOUND" }, 404)
  },
})

console.log(`portal-runner ouvindo em :${server.port} — auth ${TOKEN ? "on" : "OFF (POST bloqueado)"}`)
