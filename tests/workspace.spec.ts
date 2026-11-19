import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const files: Record<string, { content: string; revision: string }> = {
      "index.md": {
        content:
          "# Welcome to KeivBook\n\nYour notes, on your computer.\n\n## Make room for ideas\n\n- Create a note from the Explorer\n- Switch between **Edit**, **View**, and **Code**\n- Press **Ctrl+S** to save\n\n> Ordinary Markdown. A little more organized.\n\n[Ideas](notes/ideas.md)",
        revision: "1",
      },
      "notes/index.md": {
        content: "# Notes\n\nA home for everything worth remembering.",
        revision: "1",
      },
      "notes/ideas.md": {
        content:
          "# Ideas\n\n**Account:** {{vault.personal_user.password}}\n\n| Project | Status |\n| --- | --- |\n| KeivBook | In progress |",
        revision: "1",
      },
    };
    let configured = false,
      repository = false,
      remote: string | null = null,
      vault: { content: string; revision: string } | null = null,
      count = 1;
    const callbacks = new Map<number, (e: unknown) => void>();
    let nextId = 1;
    function entries(prefix = ""): unknown[] {
      const children = new Map<string, unknown>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const name = path.slice(prefix.length).split("/")[0],
          p = prefix + name;
        if (path === p)
          children.set(name, { path: p, name, directory: false, children: [] });
        else
          children.set(name, {
            path: p,
            name,
            directory: true,
            children: entries(p + "/"),
          });
      }
      return [...children.values()];
    }
    const state = {
      repository,
      configured,
      remote,
      location: "C:\\KeivBook\\data",
    };
    Object.assign(window, {
      __testFiles: files,
      __testGetVault: () => vault,
      __TAURI_INTERNALS__: {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        transformCallback: (cb: (e: unknown) => void) => {
          const id = nextId++;
          callbacks.set(id, cb);
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (cmd: string, args: Record<string, any> = {}) => {
          if (cmd === "list_tree") return entries();
          if (cmd === "setup_status") return { ...state };
          if (cmd === "configure_git") {
            state.configured = true;
            state.repository = args.initialize;
            state.remote = args.remote;
            return { ...state };
          }
          if (cmd === "read_file") {
            if (!files[args.path]) throw Error("File not found");
            return { ...files[args.path] };
          }
          if (cmd === "write_file") {
            if ((files[args.path]?.revision ?? null) !== args.expectedRevision)
              throw Error("CONFLICT: File changed on disk");
            const revision = String(++count);
            files[args.path] = { content: args.content, revision };
            return revision;
          }
          if (cmd === "create_file") {
            if (files[args.path]) throw Error("File exists");
            files[args.path] = { content: "", revision: String(++count) };
            return;
          }
          if (cmd === "read_vault") return vault;
          if (cmd === "write_vault") {
            const delay = (window as any).__testVaultWriteDelay || 0;
            if (delay)
              await new Promise((resolve) => setTimeout(resolve, delay));
            if ((vault?.revision ?? null) !== args.expectedRevision)
              throw Error("CONFLICT");
            const revision = String(++count);
            vault = { content: args.encryptedBytes, revision };
            return revision;
          }
          if (cmd === "plugin:event|listen") return nextId++;
          if (
            cmd === "plugin:event|unlisten" ||
            cmd === "plugin:window|destroy" ||
            cmd === "plugin:window|set_theme"
          )
            return;
          throw Error(`Unexpected command: ${cmd}`);
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
  });
  await page.goto("/");
  await expect(page.getByRole("dialog")).toBeVisible();
});
test("first launch, independent Git setup, and both themes", async ({
  page,
}) => {
  await expect(
    page.getByRole("heading", { name: "Version your notes with Git" }),
  ).toBeVisible();
  await page
    .getByLabel("Remote repository (optional)")
    .fill("https://example.com/private.git");
  await page
    .getByRole("button", { name: "Create repository", exact: true })
    .click();
  await expect(page.locator("#git-status")).toContainText("Git");
  await expect(page.locator(".tiptap h1")).toHaveText("Welcome to KeivBook");
  await page.evaluate(() => localStorage.setItem("keivbook.theme", "dark"));
  if ((await page.locator("html").getAttribute("data-theme")) !== "dark")
    await page.getByRole("button", { name: "Toggle color theme" }).click();
  await page.screenshot({ path: ".qa/dark.png" });
  await page.getByRole("button", { name: "Toggle color theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: ".qa/light.png" });
});
test("edits survive mode switches and save, folder click opens its homepage", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Create repository", exact: true })
    .click();
  await page.getByRole("button", { name: "notes", exact: true }).click();
  await expect(page.locator("#breadcrumb")).toContainText("notes  /  index.md");
  await page.getByRole("button", { name: "ideas.md", exact: true }).click();
  await expect(page.locator(".tiptap")).toContainText(
    "{{vault.personal_user.password}}",
  );
  await page.locator(".tiptap").press("Control+End");
  await page.locator(".tiptap").press("Enter");
  await page.locator(".tiptap").pressSequentially("A new thought");
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("A new thought");
  await expect(page.locator(".cm-content")).toContainText(
    "{{vault.personal_user.password}}",
  );
  await page.getByRole("button", { name: "View", exact: true }).click();
  await expect(page.locator("#editor")).toContainText("A new thought");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#save-status")).toHaveText("All changes saved");
  expect(
    await page.evaluate(
      () => (window as any).__testFiles["notes/ideas.md"].content,
    ),
  ).toContain("A new thought");
});
test("search and new note workflow", async ({ page }) => {
  await page
    .getByRole("button", { name: "Create repository", exact: true })
    .click();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search notes" })
    .fill("worth remembering");
  await page.locator(".search-result").click();
  await expect(page.locator("#breadcrumb")).toContainText("notes  /  index.md");
  await page.keyboard.press("Control+n");
  await page.getByLabel("Note path").fill("notes/new.md");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator("#breadcrumb")).toContainText("notes  /  new.md");
});
test("vault create, variable, lock, unlock, and no plaintext persisted", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Create repository", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Encrypted vault", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create encrypted vault", exact: true })
    .click();
  await page
    .getByLabel("Master password", { exact: true })
    .fill("test-only-password");
  await page.getByLabel("Confirm master password").fill("test-only-password");
  await page.getByRole("button", { name: "Create vault", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Vault is unlocked" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add variable", exact: true }).click();
  await page.getByLabel("Variable name").fill("personal_user.password");
  await page.getByLabel("Secret value").fill("synthetic-test-secret");
  await page.getByRole("button", { name: "Save value", exact: true }).click();
  await expect(page.locator(".vault-key")).toHaveText("personal_user.password");
  const envelope = await page.evaluate(
    () => (window as any).__testGetVault().content,
  );
  expect(envelope).not.toContain("synthetic-test-secret");
  expect(envelope).not.toContain("test-only-password");
  await page.evaluate(() => {
    (window as any).__testVaultWriteDelay = 500;
  });
  await page
    .getByRole("button", { name: "Edit variable", exact: true })
    .click();
  await page.getByLabel("Secret value").fill("synthetic-test-secret");
  await page.getByRole("button", { name: "Save value", exact: true }).click();
  await page.getByRole("button", { name: "Lock vault", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__testGetVault().content))
    .not.toBe(envelope);
  await expect(
    page.getByRole("button", { name: "Unlock vault", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".locked-key")).toHaveText(
    "personal_user.password",
  );
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "synthetic-test-secret",
  );
  await page.getByRole("button", { name: "Unlock vault", exact: true }).click();
  await page
    .getByLabel("Master password", { exact: true })
    .fill("test-only-password");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Vault is unlocked" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  await page.getByRole("button", { name: "Expand folder" }).click();
  await page.getByRole("button", { name: "ideas.md", exact: true }).click();
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page
    .getByRole("button", { name: "Show / hide value", exact: true })
    .click();
  await expect(page.locator(".vault-chip")).toContainText(
    "synthetic-test-secret",
  );
  await page.keyboard.press("Control+Shift+l");
  await expect(page.locator(".vault-chip")).toContainText("Locked");
  await expect(page.locator("body")).not.toContainText("synthetic-test-secret");
});

test("a stale save preserves both disk changes and the unsaved note", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Create repository", exact: true })
    .click();
  await page.locator(".tiptap").press("Control+End");
  await page.locator(".tiptap").press("Enter");
  await page.locator(".tiptap").pressSequentially("My unsaved thought");
  await page.evaluate(() => {
    (window as any).__testFiles["index.md"] = {
      content: "# External change",
      revision: "external",
    };
  });
  await page.keyboard.press("Control+s");
  await expect(page.locator(".conflict-banner")).toBeVisible();
  await expect(page.locator(".tiptap")).toContainText("My unsaved thought");
  expect(
    await page.evaluate(() => (window as any).__testFiles["index.md"].content),
  ).toBe("# External change");
  await page.getByRole("button", { name: "Save a copy", exact: true }).click();
  await page.getByLabel("Path", { exact: true }).fill("recovered.md");
  await page.getByRole("button", { name: "Save copy", exact: true }).click();
  await expect(page.locator("#breadcrumb")).toContainText("recovered.md");
  expect(
    await page.evaluate(
      () => (window as any).__testFiles["recovered.md"].content,
    ),
  ).toContain("My unsaved thought");
});
