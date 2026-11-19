import { defineConfig } from "vite";
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/@tiptap|prosemirror|\/marked\//.test(id)) return "rich-editor";
          if (/@codemirror|@lezer|\/codemirror\//.test(id))
            return "source-editor";
          if (id.includes("hash-wasm")) return "vault-crypto";
          if (id.includes("lucide")) return "icons";
          if (/markdown-it|dompurify/.test(id)) return "markdown";
        },
      },
    },
  },
});
