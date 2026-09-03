import { describe, expect, it, afterEach } from "bun:test"
import { htmlToPdf, isPdf, toBase64, PdfError } from "../src/pdf.js"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])

describe("isPdf", () => {
  it("reconhece a assinatura %PDF", () => {
    expect(isPdf(PDF_BYTES)).toBe(true)
  })

  it("rejeita HTML devolvido com status 200", () => {
    // O caso real: um proxy responde uma página de erro no lugar do PDF.
    const html = new TextEncoder().encode("<!DOCTYPE html><html>erro</html>")
    expect(isPdf(html)).toBe(false)
  })

  it("rejeita corpo vazio ou curto demais", () => {
    expect(isPdf(new Uint8Array([]))).toBe(false)
    expect(isPdf(new Uint8Array([0x25, 0x50]))).toBe(false)
  })
})

describe("toBase64", () => {
  it("codifica os bytes", () => {
    expect(toBase64(PDF_BYTES)).toBe(Buffer.from(PDF_BYTES).toString("base64"))
  })
})

describe("htmlToPdf", () => {
  it("envia multipart com o arquivo chamado index.html", async () => {
    let capturado: FormData | null = null
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturado = init.body as FormData
      return new Response(PDF_BYTES, { status: 200 })
    }) as typeof fetch

    const out = await htmlToPdf("<html><body>oi</body></html>")
    expect(isPdf(out)).toBe(true)

    const file = capturado!.get("files") as File
    expect(file.name).toBe("index.html")
    // Margem zero: quem controla o respiro é o CSS, não o Gotenberg.
    expect(capturado!.get("marginTop")).toBe("0")
    expect(capturado!.get("printBackground")).toBe("true")
  })

  it("transforma erro do Gotenberg em PdfError com o status original", async () => {
    globalThis.fetch = (async () =>
      new Response("chromium falhou", { status: 500 })) as unknown as typeof fetch

    const p = htmlToPdf("<html></html>")
    await expect(p).rejects.toBeInstanceOf(PdfError)
    await expect(p).rejects.toThrow(/500/)
  })

  it("vira 502 quando a rede falha", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch

    try {
      await htmlToPdf("<html></html>")
      throw new Error("deveria ter lançado")
    } catch (e) {
      expect(e).toBeInstanceOf(PdfError)
      expect((e as PdfError).status).toBe(502)
    }
  })

  it("vira 504 no timeout", async () => {
    globalThis.fetch = ((_u: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted")
          err.name = "AbortError"
          reject(err)
        })
      })) as typeof fetch

    try {
      await htmlToPdf("<html></html>", 20)
      throw new Error("deveria ter lançado")
    } catch (e) {
      expect(e).toBeInstanceOf(PdfError)
      expect((e as PdfError).status).toBe(504)
    }
  })
})
