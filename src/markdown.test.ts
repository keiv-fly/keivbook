// @vitest-environment jsdom
import { it, expect } from "vitest";
import { renderMarkdown, resolveLink, relativePath } from "./markdown";
it("renders notes without executable HTML", () => {
  const out = renderMarkdown(
    "<script>alert(1)</script>\n\n[x](javascript:alert(1))",
  );
  expect(out).not.toContain("<script>");
  expect(out).not.toContain('href="javascript:');
});
it("resolves only local paths inside data", () => {
  expect(resolveLink("notes/a.md", "../index.md#hello")).toEqual({
    path: "index.md",
    hash: "hello",
  });
  for (const x of [
    "../../out.md",
    "javascript:alert(1)",
    "//host/x",
    "%2e%2e/%2e%2e/x",
    "../vault.enc",
    "../.git/config",
    "C:/x",
    "%5coutside",
  ])
    expect(resolveLink("notes/a.md", x)).toBeNull();
});
it("builds relative image paths", () => {
  expect(relativePath("notes/deep/a.md", "images/a b.png")).toBe(
    "../../images/a%20b.png",
  );
});
