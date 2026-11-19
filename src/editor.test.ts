// @vitest-environment jsdom
import { it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import {
  VaultReference,
  preserveTypedReferences,
  localImage,
} from "./extensions";
import { renderMarkdown } from "./markdown";
it("preserves vault variables, tables, links, and Markdown formatting on edits", () => {
  const text =
    "# Note\n\n**Account:** {{vault.personal_user.password}}\n\n[Next](notes/next.md)\n\n| A | B |\n| --- | --- |\n| 1 | 2 |";
  const e = new Editor({
    extensions: [StarterKit, TableKit, VaultReference, Markdown],
    content: text,
    contentType: "markdown",
  });
  expect(e.getMarkdown()).toContain("{{vault.personal_user.password}}");
  expect(renderMarkdown(e.getMarkdown())).toBe(renderMarkdown(text));
  e.commands.insertContentAt(e.state.doc.content.size, {
    type: "paragraph",
    content: [{ type: "text", text: "Another thought" }],
  });
  expect(e.getMarkdown()).toContain("{{vault.personal_user.password}}");
  e.destroy();
});
it("keeps newly typed placeholders literal", () =>
  expect(preserveTypedReferences("{{vault.personal\\_user.password}}")).toBe(
    "{{vault.personal_user.password}}",
  ));
it("keeps image paths in Markdown rather than presentation URLs", () => {
  const e = new Editor({
    extensions: [StarterKit, localImage("notes/a.md"), Markdown],
    content: "![Test](../images/test.png)",
    contentType: "markdown",
  });
  expect(e.getMarkdown()).toBe("![Test](../images/test.png)");
  e.destroy();
});
