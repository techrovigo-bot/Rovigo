import { API_BASE, jsonFetch, mapJobDetail, normalizeId, writeError } from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const id = normalizeId(opts.id)
  if (!id) {
    writeError(`Não consegui extrair um id de vaga de "${opts.id}"`, "BAD_ID")
    return 1
  }
  try {
    const payload = (await jsonFetch(`${API_BASE}/${id}`)) as Record<string, unknown> | null
    if (!payload) {
      writeError("Vaga não encontrada (pode ter sido encerrada)", "NOT_FOUND")
      return 1
    }
    const job = mapJobDetail(payload)
    if (!job) {
      writeError("Resposta da API sem id ou título utilizáveis", "BAD_RESPONSE")
      return 1
    }

    if (opts.format === "plain") {
      const lines = [
        job.title,
        `${job.company || "—"} · ${job.location || "—"}`,
        "",
        job.date ? `Publicada: ${job.date.slice(0, 10)}` : "",
        job.applicationDeadline ? `Inscrições até: ${job.applicationDeadline}` : "",
        job.workplaceType ? `Modelo: ${job.workplaceType}` : "",
        job.contractType ? `Contrato: ${job.contractType}` : "",
        job.disabilityFriendly ? "Vaga afirmativa PCD" : "",
        "",
        job.description || "(sem descrição)",
        "",
        `URL: ${job.url}`,
      ].filter((l) => l !== "")
      process.stdout.write(lines.join("\n") + "\n")
    } else {
      process.stdout.write(JSON.stringify(job, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
