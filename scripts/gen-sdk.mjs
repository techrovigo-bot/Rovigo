// Gera o código do n8n Workflow SDK para um workflow, extraindo o jsCode e a
// estrutura de nós/conexões diretamente do JSON exportado (n8n/workflows/*.json),
// usando JSON.stringify para escapar o jsCode com segurança (evita erro manual
// de transcrição de aspas/crases/template literals).
import { readFileSync } from "node:fs"

const file = process.argv[2]
const wf = JSON.parse(readFileSync(file, "utf-8"))

const varName = (name) => name.replace(/[^a-zA-Z0-9]/g, "").replace(/^./, (c) => c.toLowerCase())

let out = ""
const nodeVars = []

for (const n of wf.nodes) {
  const v = varName(n.name)
  nodeVars.push({ v, name: n.name })
  if (n.type === "n8n-nodes-base.scheduleTrigger") {
    const expr = n.parameters.rule.interval[0].expression
    out += `const ${v} = trigger({\n  type: 'n8n-nodes-base.scheduleTrigger',\n  version: 1.4,\n  config: { name: ${JSON.stringify(n.name)}, parameters: { rule: { interval: [{ field: 'cronExpression', expression: ${JSON.stringify(expr)} }] } } },\n  output: [{}]\n});\n\n`
  } else if (n.type === "n8n-nodes-base.webhook") {
    out += `const ${v} = trigger({\n  type: 'n8n-nodes-base.webhook',\n  version: 2.1,\n  config: { name: ${JSON.stringify(n.name)}, parameters: { httpMethod: ${JSON.stringify(n.parameters.httpMethod)}, path: ${JSON.stringify(n.parameters.path)}, responseMode: ${JSON.stringify(n.parameters.responseMode)}, options: {} } },\n  output: [{ body: {} }]\n});\n\n`
  } else if (n.type === "n8n-nodes-base.code") {
    out += `const ${v} = node({\n  type: 'n8n-nodes-base.code',\n  version: 2,\n  config: { name: ${JSON.stringify(n.name)}, parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: ${JSON.stringify(n.parameters.jsCode)} } },\n  output: [{}]\n});\n\n`
  } else {
    throw new Error("tipo de nó não suportado: " + n.type)
  }
}

// Monta a cadeia de .add()/.to() a partir de connections, seguindo cada
// trigger até o fim da cadeia linear (todos os 5 workflows são lineares).
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]))
const triggerNames = wf.nodes.filter((n) => n.type.includes("Trigger") || n.type === "n8n-nodes-base.webhook").map((n) => n.name)

let chainCode = `export default workflow(${JSON.stringify(wf.name)}, ${JSON.stringify(wf.name)})\n`
for (const tName of triggerNames) {
  const path = [tName]
  let cur = tName
  while (wf.connections[cur] && wf.connections[cur].main && wf.connections[cur].main[0] && wf.connections[cur].main[0][0]) {
    cur = wf.connections[cur].main[0][0].node
    path.push(cur)
  }
  const vpath = path.map((n) => nodeVars.find((x) => x.name === n).v)
  chainCode += `  .add(${vpath[0]})\n`
  for (let i = 1; i < vpath.length; i++) chainCode += `  .to(${vpath[i]})\n`
}
chainCode = chainCode.replace(/\n$/, ";\n")

out += chainCode
console.log(out)
