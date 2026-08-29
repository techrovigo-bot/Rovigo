import { describe, expect, test } from "bun:test";
import { runCLI, parseJSON } from "./helpers";

// Live smoke test against the real portal, required by add-portal.md Step 4.
// Kept to a handful of requests so the suite stays a courteous visitor.

interface SearchResponse {
  meta: { count: number; page: number; total: number | null };
  results: Array<{
    id: string;
    title: string;
    url: string;
    company: string | null;
    location: string | null;
    date: string | null;
  }>;
}

describe("Gupy live smoke test", () => {
  test("search returns real, complete results", async () => {
    const response = parseJSON<SearchResponse>(
      await runCLI(["search", "-q", "analista de dados", "--limit", "5"]),
    );
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.meta.count).toBe(response.results.length);
    for (const job of response.results) {
      expect(job.id).toMatch(/^\d+$/);
      expect(job.title.length).toBeGreaterThan(0);
      // A title carrying markup means the parser grabbed a raw chunk.
      expect(job.title).not.toContain("<");
      expect(job.url).toStartWith("https://");
      // Contract: absent values are null, never omitted from the object.
      expect(job).toHaveProperty("company");
      expect(job).toHaveProperty("location");
      expect(job).toHaveProperty("date");
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
