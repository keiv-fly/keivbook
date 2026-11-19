import { Node } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { api } from "./api";
import { resolveLink } from "./markdown";

// Editable inline text with a dedicated serializer: underscores in vault keys must not be escaped.
export const VaultReference = Node.create({
  name: "vaultReference",
  group: "inline",
  inline: true,
  content: "text*",
  marks: "",
  selectable: false,
  parseHTML: () => [{ tag: "span[data-vault-reference]" }],
  renderHTML: () => [
    "span",
    { "data-vault-reference": "", class: "vault-reference" },
    0,
  ],
  markdownTokenizer: {
    name: "vaultReference",
    level: "inline",
    start: (src) => src.indexOf("{{vault."),
    tokenize: (src) => {
      const m = /^\{\{vault\.[a-zA-Z0-9_.-]+\}\}/.exec(src);
      if (m) return { type: "vaultReference", raw: m[0] };
    },
  },
  parseMarkdown: (token) => ({
    type: "vaultReference",
    content: [{ type: "text", text: token.raw }],
  }),
  renderMarkdown: (node) =>
    (node.content || []).map((c: { text?: string }) => c.text || "").join(""),
});
export function preserveTypedReferences(source: string): string {
  return source.replace(/\{\{vault\.([^{}]+)\}\}/g, (full, key: string) => {
    const clean = key.replace(/\\([_*.-])/g, "$1");
    return /^[a-zA-Z0-9_.-]+$/.test(clean) ? `{{vault.${clean}}}` : full;
  });
}
export function localImage(note: string) {
  return Image.extend({
    addNodeView() {
      return ({ node }) => {
        const img = document.createElement("img");
        img.alt = node.attrs.alt || "";
        const target = resolveLink(note, node.attrs.src || "");
        let url: string | undefined,
          disposed = false;
        if (target)
          void api
            .asset(target.path)
            .then((bytes) => {
              if (disposed) return;
              const ext = target.path.split(".").pop()?.toLowerCase();
              url = URL.createObjectURL(
                new Blob([new Uint8Array(bytes)], {
                  type: `image/${ext === "jpg" ? "jpeg" : ext}`,
                }),
              );
              img.src = url;
            })
            .catch(() => {
              img.alt = `Missing image: ${node.attrs.src}`;
            });
        else img.alt = "External images are disabled";
        // Blob URLs belong to this view, never to the ProseMirror document or Markdown.
        return {
          dom: img,
          ignoreMutation: () => true,
          destroy: () => {
            disposed = true;
            if (url) URL.revokeObjectURL(url);
          },
        };
      };
    },
  }).configure({ allowBase64: false });
}
