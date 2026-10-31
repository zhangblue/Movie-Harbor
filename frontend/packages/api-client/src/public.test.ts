import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import { listCatalog, type CatalogQuery } from "./public";

afterEach(() => vi.unstubAllGlobals());

it("forwards the typed private catalog filter and ignores unrelated properties", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response('{"page":2,"size":20,"total":0,"items":[]}', {
      headers: { "content-type": "application/json" },
    });
  });
  const query = {
    kind: "series",
    q: "星 海",
    privacy: "private",
    page: 2,
    size: 20,
    include_private: true,
  } as const;

  await listCatalog(query);

  expect(urls).toEqual(["/api/catalog?kind=series&q=%E6%98%9F+%E6%B5%B7&privacy=private&page=2&size=20"]);
});

it("keeps the public catalog privacy query as one explicit literal", () => {
  expectTypeOf<CatalogQuery["privacy"]>().toEqualTypeOf<"private" | undefined>();
});
