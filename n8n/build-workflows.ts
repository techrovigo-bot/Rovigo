// Gera os JSONs importáveis do n8n a partir dos corpos de código em src/*.code.js.
// Escrever o JS num arquivo e embutir via JSON.stringify garante o escaping
// correto (nada de aspas/quebras de linha manuais dentro do JSON).
//
//   bun run build-workflows.ts

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const ROOT = import.meta.dir
const OUT = join(ROOT, "workflows")
mkdirSync(OUT, { recursive: true })

type N8nNode = { parameters: unknown; id: string; name: string; type: string; typeVersion: number; position: [number, number]; webhookId?: string }

function scheduleTrigger(cron: string): N8nNode {
  return {
    parameters: { rule: { interval: [{ field: "cronExpression", expression: cron }] } },
    id: "trigger", name: "Schedule", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [0, 0],
  }
}

function webhookTrigger(path: string): N8nNode {
  return {
    parameters: { httpMethod: "POST", path, responseMode: "onReceived", options: {} },
    id: "trigger", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], webhookId: path,
  }
}

function codeNode(codeFile: string, name: string, idx: number): N8nNode {
  const jsCode = readFileSync(join(ROOT, "src", codeFile), "utf-8")
  return {
    parameters: { mode: "runOnceForAllItems", jsCode },
    id: `code${idx}`, name, type: "n8n-nodes-base.code", typeVersion: 2, position: [320 * (idx + 1), 0],
  }
}

/** Monta um workflow linear: trigger → code1 → code2 → ... */
function workflow(name: string, trigger: N8nNode, chain: { file: string; name: string }[]) {
  const nodes: N8nNode[] = [trigger]
  const connections: Record<string, { main: { node: string; type: string; index: number }[][] }> = {}
  let prev = trigger
  chain.forEach((c, i) => {
    const node = codeNode(c.file, c.name, i)
    nodes.push(node)
    connections[prev.name] = { main: [[{ node: node.name, type: "main", index: 0 }]] }
    prev = node
  })
  return { name, nodes, connections, active: false, settings: { executionOrder: "v1" } }
}

const workflows = {
  "ingest-bucket": workflow("ingest-bucket", scheduleTrigger("0 6 * * *"), [{ file: "ingest.code.js", name: "Ingest vagas" }]),
  "embed-jobs": workflow("embed-jobs", scheduleTrigger("30 6 * * *"), [{ file: "embed-jobs.code.js", name: "Embutir vagas" }]),
  "rank-daily": workflow("rank-daily", scheduleTrigger("0 7 * * *"), [{ file: "rank.code.js", name: "Rank por tenant" }]),
  "notify-daily": workflow("notify-daily", scheduleTrigger("0 8 * * *"), [{ file: "notify.code.js", name: "Notificar" }]),
  "onboarding-hook": workflow("onboarding-hook", webhookTrigger("onboarding"), [
    { file: "embed-profile.code.js", name: "Embutir perfil" },
    { file: "rank.code.js", name: "Rank por tenant" },
    { file: "notify.code.js", name: "Notificar" },
  ]),
  // v2: sob demanda, disparado pelo painel quando o candidato pede os documentos.
  "generate-docs": workflow("generate-docs", webhookTrigger("generate-docs"), [
    { file: "generate-docs.code.js", name: "Gerar documentos" },
  ]),
}

for (const [name, wf] of Object.entries(workflows)) {
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(wf, null, 2) + "\n")
}
console.log("Gerados:", Object.keys(workflows).map((n) => `workflows/${n}.json`).join(", "))
