import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
const md = new MarkdownIt({ html: false, linkify: false, breaks: false });
export function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(md.render(source), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "iframe", "object"],
    FORBID_ATTR: ["style", "srcset", "id", "name"],
  });
}
export function resolveLink(
  note: string,
  href: string,
): { path: string; hash: string } | null {
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(href) ||
    href.startsWith("//") ||
    href.includes("\\")
  )
    return null;
  const [raw, hash = ""] = href.split("#");
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (
    decoded.includes(":") ||
    decoded.includes("\\") ||
    decoded.startsWith("/") ||
    decoded.includes("?")
  )
    return null;
  const parts = raw ? note.split("/").slice(0, -1) : note.split("/");
  if (raw)
    for (const part of decoded.split("/")) {
      if (part === "..") {
        if (!parts.length) return null;
        parts.pop();
      } else if (part && part !== ".") {
        if (part.startsWith(".") || part.toLowerCase() === "vault.enc")
          return null;
        parts.push(part);
      }
    }
  return { path: parts.join("/"), hash };
}
export function relativePath(note: string, target: string): string {
  const a = note.split("/").slice(0, -1),
    b = target.split("/");
  while (a.length && b.length && a[0] === b[0]) {
    a.shift();
    b.shift();
  }
  return [...a.map(() => ".."), ...b]
    .map((p) => (p === ".." ? p : encodeURIComponent(p)))
    .join("/");
}
export function headingId(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}
