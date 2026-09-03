import { describe, expect, it, afterEach } from "bun:test"
import { uploadPdf, StorageError, storageConfigured } from "../src/storage.js"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])

// storage.ts lê as env no import, então estes testes assumem o que houver no
// ambiente. Em CI sem as chaves, storageConfigured() é false e uploadPdf falha
// cedo — que é o comportamento correto e o que verificamos.
const configurado = storageConfigured()

describe("uploadPdf", () => {
  it.skipIf(configurado)("falha claro quando não há chaves", async () => {
    try {
      await uploadPdf("t1", "d1", PDF)
      throw new Error("deveria ter lançado")
    } catch (e) {
      expect(e).toBeInstanceOf(StorageError)
      expect((e as StorageError).status).toBe(503)
    }
  })

  it.skipIf(!configurado)("monta o caminho {tenant}/{documento}.pdf e envia bytes crus", async () => {
    let capturado: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturado = { url, init }
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch

    const path = await uploadPdf("tenant-abc", "doc-123", PDF)
    expect(path).toBe("tenant-abc/doc-123.pdf")
    expect(capturado!.url).toContain("/storage/v1/object/documents/tenant-abc/doc-123.pdf")

    const headers = capturado!.init.headers as Record<string, string>
    expect(headers["Content-Type"]).toBe("application/pdf")
    // Regerar sobrescreve: sem x-upsert o Storage recusaria o segundo upload.
    expect(headers["x-upsert"]).toBe("true")
    // O corpo tem que ser os bytes, não JSON — foi exatamente o bug do n8n.
    expect(capturado!.init.body).toBeInstanceOf(Uint8Array)
  })

  it.skipIf(!configurado)("propaga o status de erro do Storage", async () => {
    globalThis.fetch = (async () =>
      new Response("bucket not found", { status: 404 })) as unknown as typeof fetch

    try {
      await uploadPdf("t", "d", PDF)
      throw new Error("deveria ter lançado")
    } catch (e) {
      expect(e).toBeInstanceOf(StorageError)
      expect((e as StorageError).status).toBe(404)
    }
  })
})
