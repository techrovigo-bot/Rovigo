// Executa um CLI de portal como subprocesso e traduz o resultado para a resposta
// HTTP, preservando o contrato dos CLIs:
//   - exit 0 + JSON em stdout  -> 200 com o JSON verbatim
//   - exit 1 + {error,code} em stderr -> 502 com esse corpo
//   - estouro de tempo -> 504
//
// Tratar o CLI como caixa-preta é proposital: uma atualização do CLI (novo
// parser, novo portal) não exige mudar o runner, e o contrato JSON continua
// sendo a única superfície de acoplamento.

import { PORTALS, type Portal } from "./portals.js"

export interface RunOk {
  ok: true
  data: unknown
}
export interface RunErr {
  ok: false
  status: number
  body: { error: string; code: string; portal: string; stderr?: string }
}
export type RunResult = RunOk | RunErr

const DEFAULT_TIMEOUT_MS = Number(process.env.PORTAL_RUNNER_TIMEOUT_MS ?? 30000)

export async function runCli(
  portal: Portal,
  cmd: "search" | "detail",
  args: string[],
): Promise<RunResult> {
  const def = PORTALS[portal]
  const proc = Bun.spawn(["bun", def.cliEntry, cmd, ...args], {
    cwd: def.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, DEFAULT_TIMEOUT_MS)

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)

  if (timedOut) {
    return { ok: false, status: 504, body: { error: `portal '${portal}' excedeu ${DEFAULT_TIMEOUT_MS}ms`, code: "TIMEOUT", portal } }
  }

  if (code === 0) {
    try {
      return { ok: true, data: JSON.parse(stdout) }
    } catch {
      // Sucesso do processo mas stdout não-JSON: contrato violado. Não mascarar.
      return { ok: false, status: 502, body: { error: `saída do portal '${portal}' não é JSON válido`, code: "BAD_OUTPUT", portal, stderr: stdout.slice(0, 500) } }
    }
  }

  // Falha do CLI: o contrato manda {error,code} em stderr.
  try {
    const parsed = JSON.parse(stderr.trim().split("\n").pop() ?? "{}")
    return { ok: false, status: 502, body: { error: parsed.error ?? "erro no CLI", code: parsed.code ?? "CLI_ERROR", portal } }
  } catch {
    return { ok: false, status: 502, body: { error: `portal '${portal}' falhou (exit ${code})`, code: "CLI_ERROR", portal, stderr: stderr.slice(0, 500) } }
  }
}
