import { BASE, buildDetail, extractJsonLd, htmlFetch, normalizeId, writeError } from "../helpers.js"

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
  // /vagas/v<id> 301s to /vagas/v<id>/<slug>; htmlFetch follows redirects, so
  // the slug never has to be known or guessed.
  const url = `${BASE}/vagas/v${id}`
  try {
    const html = await htmlFetch(url)
    if (!html) {
      writeError("Vaga não encontrada (pode ter sido encerrada)", "NOT_FOUND")
      return 1
    }
    const ld = extractJsonLd(html)
    if (!ld) {
      writeError(
        "A página da vaga não trouxe o bloco JobPosting (schema.org). O portal pode ter mudado o markup — ver url-reference.md.",
        "NO_JSONLD",
      )
      return 1
    }
    const job = buildDetail(ld, id, url)

    if (opts.format === "plain") {
      const lines = [
        job.title,
        `${job.company || "—"} · ${job.location || "—"}`,
        "",
        job.date ? `Publicada: ${job.date}` : "",
        job.validThrough ? `Aceita candidaturas até: ${job.validThrough}` : "",
        job.benefits ? `Benefícios: ${job.benefits}` : "",
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
