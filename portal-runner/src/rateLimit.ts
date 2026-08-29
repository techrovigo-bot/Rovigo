// Rate limit central por portal.
//
// Execução SERIAL por portal (concorrência 1) com intervalo mínimo entre
// execuções — a defesa mais simples e segura contra bloqueio de scraping.
// Em memória: vale para uma única instância do portal-runner, que é o desenho
// do MVP (o volume contra o portal é desacoplado do número de clientes pelos
// search buckets, não pela escala horizontal do runner). Se um dia rodar N
// instâncias, este limitador migra para um lock em Redis.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class PortalLimiter {
  private chain = new Map<string, Promise<void>>()
  private lastStart = new Map<string, number>()

  constructor(private maxQueue = 20) {}

  private queued = new Map<string, number>()

  /** Executa fn respeitando a ordem serial e o intervalo mínimo do portal.
   *  Rejeita (429) se a fila do portal já estiver cheia. */
  async run<T>(portal: string, minIntervalMs: number, fn: () => Promise<T>): Promise<T> {
    const depth = this.queued.get(portal) ?? 0
    if (depth >= this.maxQueue) {
      const e = new Error(`fila do portal '${portal}' cheia (${this.maxQueue}); tente mais tarde`) as Error & { status: number; code: string }
      e.status = 429
      e.code = "RATE_LIMITED"
      throw e
    }
    this.queued.set(portal, depth + 1)

    const prev = this.chain.get(portal) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((r) => (release = r))
    // Encadeia: o próximo só começa quando este liberar.
    this.chain.set(portal, prev.then(() => mine))

    try {
      await prev
      const since = Date.now() - (this.lastStart.get(portal) ?? 0)
      if (since < minIntervalMs) await sleep(minIntervalMs - since)
      this.lastStart.set(portal, Date.now())
      return await fn()
    } finally {
      this.queued.set(portal, (this.queued.get(portal) ?? 1) - 1)
      release()
    }
  }
}
