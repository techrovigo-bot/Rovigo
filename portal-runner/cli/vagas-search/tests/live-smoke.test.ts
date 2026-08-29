import { describe, expect, test } from "bun:test";
import { runCLI, parseJSON } from "./helpers";

// Live smoke test against the real portal, required by add-portal.md Step 4.
// Kept to a handful of requests so the suite stays a courteous visitor.

interface SearchResponse {
  meta: { count: number; page: number };
  results: Array<{
    id: string;
    title: string;
    url: string;
    company: string | null;
    location: string | null;
    date: string | null;
  }>;
}

describe("Vagas.com live smoke test", () => {
  test("search returns real, complete results", async () => {
    const response = parseJSON<SearchResponse>(
      await runCLI(["search", "-q", "analista de dados", "--limit", "5"]),
    );
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.meta.count).toBe(response.results.length);
    for (const job of response.results) {
      expect(job.id).toMatch(/^\d+$/);
      expect(job.title.length).toBeGreaterThan(0);
      // Markup in a field means the parser grabbed a raw chunk. A bare "&" is
      // fine and common ("Dados & Analytics"); an undecoded entity is not.
      expect(job.title).not.toContain("<");
      expect(job.title).not.toMatch(/&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#[xX][0-9a-fA-F]+);/);
      expect(job.url).toStartWith("https://www.vagas.com.br/vagas/");
      expect(job).toHaveProperty("company");
      expect(job).toHaveProperty("location");
      expect(job).toHaveProperty("date");
    }
  });

  test("dates come back as ISO, including the relative ones", async () => {
    const response = parseJSON<SearchResponse>(
      await runCLI(["search", "-q", "analista", "--limit", "20"]),
    );
    const dated = response.results.filter((j) => j.date !== null);
    expect(dated.length).toBeGreaterThan(0);
    for (const job of dated) {
      expect(job.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("detail on a searched id returns a readable description", async () => {
    const search = parseJSON<SearchResponse>(
      await runCLI(["search", "-q", "analista de dados", "--limit", "1"]),
    );
    const id = search.results[0]!.id;
    const detail = parseJSON<{ id: string; title: string; description: string | null }>(
      await runCLI(["detail", id]),
    );
    expect(detail.id).toBe(id);
    expect(detail.title.length).toBeGreaterThan(0);
    if (detail.description !== null) {
      expect(detail.description).not.toContain("<p>");
      expect(detail.description).not.toContain("&aacute;");
    }
  });
});
