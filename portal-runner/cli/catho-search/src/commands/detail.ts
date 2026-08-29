import {
  BASE,
  buildDetail,
  extractJsonLd,
  htmlFetch,
  normalizeId,
  writeError,
  WafBlockedError,
} from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
  browserHeaders: boolean
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const id = normalizeId(opts.id)
  if (!id) {
    writeError(`Não consegui extrair um id de vaga de "${opts.id}"`, "BAD_ID")
    return 1
  }
  // The slug in /vagas/<slug>/<id> is decorative: the id alone resolves the
  // posting, verified against the live site. So a bare id needs no lookup.
  const url = `${BASE}/vagas/vaga/${id}`
  try {
    const html = await htmlFetch(url, opts.browserHeaders)
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
        job.date ? `Publicada: ${job.date.slice(0, 10)}` : "",
        job.employmentType ? `Contrato: ${job.employmentType}` : "",
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
    if (e instanceof WafBlockedError) {
      writeError(e.message, "WAF_BLOCKED")
      return 1
    }
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
