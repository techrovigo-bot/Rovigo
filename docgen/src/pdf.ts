// HTML -> PDF via Gotenberg.
//
// Mora aqui, e não no n8n, por dois motivos. Primeiro, o Gotenberg não tem
// autenticação e por isso não é exposto na internet: quem fala com ele precisa
// estar na rede interna, e o docgen já está. Segundo, a conversão é upload
// multipart — montar isso num Code node do n8n é frágil, enquanto aqui é uma
// chamada normal.

const GOTENBERG_URL = process.env.GOTENBERG_URL ?? "http://gotenberg:3000"

/** A4 sem margem: o próprio HTML controla o respiro da página. Margem dupla
 *  (Gotenberg + CSS) foi o que quebrou o layout nos primeiros testes. */
const PAGE = {
  paperWidth: "8.27",
  paperHeight: "11.69",
  marginTop: "0",
  marginBottom: "0",
  marginLeft: "0",
  marginRight: "0",
  printBackground: "true",
} as const

export class PdfError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "PdfError"
  }
}

/** Converte um HTML completo em PDF. Devolve os bytes crus. */
export async function htmlToPdf(html: string, timeoutMs = 30000): Promise<Uint8Array> {
  const form = new FormData()
  // O Gotenberg exige que o arquivo principal se chame index.html.
  form.append("files", new Blob([html], { type: "text/html" }), "index.html")
  for (const [k, v] of Object.entries(PAGE)) form.append(k, v)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${GOTENBERG_URL}/forms/chromium/convert/html`, {
      method: "POST",
      body: form,
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300)
      throw new PdfError(`Gotenberg respondeu ${res.status}: ${detail}`, res.status)
    }
    return new Uint8Array(await res.arrayBuffer())
  } catch (e) {
    if (e instanceof PdfError) throw e
    if (e instanceof Error && e.name === "AbortError") {
      throw new PdfError(`Gotenberg não respondeu em ${timeoutMs}ms`, 504)
    }
    throw new PdfError(`falha ao falar com o Gotenberg: ${String((e as Error).message ?? e)}`, 502)
  } finally {
    clearTimeout(timer)
  }
}

/** Assinatura de um PDF válido. Um 200 com corpo que não é PDF significa que
 *  algo no meio do caminho respondeu por ele (proxy, página de erro). */
export function isPdf(bytes: Uint8Array): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 // F
  )
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}
