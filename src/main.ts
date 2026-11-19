import "./style.css";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import {
  VaultReference,
  localImage,
  preserveTypedReferences,
} from "./extensions";
import { TableKit } from "@tiptap/extension-table";
import { EditorView, basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  createIcons,
  Files,
  Search,
  LockKeyhole,
  Settings,
  ChevronRight,
  ChevronDown,
  FileText,
  Folder,
  FolderOpen,
  Plus,
  FolderPlus,
  RefreshCw,
  Sun,
  Moon,
  Save,
  X,
  GitBranch,
  ArrowUp,
  BookOpen,
  Code,
  PenLine,
  Bold,
  Italic,
  Heading2,
  List,
  Link,
  ImagePlus,
  Table,
  PanelLeftClose,
  ShieldCheck,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  ArrowRight,
  Ellipsis,
  Trash2,
} from "lucide";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, type Entry, type GitStatus, type Setup } from "./api";
import {
  renderMarkdown,
  resolveLink,
  relativePath,
  headingId,
} from "./markdown";
import {
  createSession,
  encrypt,
  unlock,
  parseEnvelope,
  auditReferences,
  validKey,
  type Session,
} from "./vault";

type Mode = "edit" | "view" | "code";
type Tab = {
  path: string;
  content: string;
  revision: string;
  dirty: boolean;
  conflict: boolean;
  mode: Mode;
  scroll: number;
  cursor: number;
};
let tree: Entry[] = [],
  tabs: Tab[] = [],
  active: Tab | undefined,
  rich: Editor | undefined,
  code: EditorView | undefined;
const saving = new Set<Tab>();
let renderedTab: Tab | undefined;
let vaultEpoch = 0;
let session: Session | null = null,
  vaultRaw: string | null = null,
  vaultRevision: string | null = null,
  vaultKeys: string[] = [],
  setup: Setup;
let panel = "explorer",
  selected = "",
  expanded = new Set<string>(),
  urls: string[] = [],
  watcherTimer: ReturnType<typeof setTimeout>,
  searchTimer: ReturnType<typeof setTimeout>,
  lastActivity = Date.now(),
  vaultBusy = false;
let theme =
  localStorage.getItem("keivbook.theme") ||
  (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
const defaultCommitMessage = "a1";
let gitMessage = defaultCommitMessage,
  gitStatus: GitStatus | undefined,
  gitError = "",
  gitBusy = false,
  gitRequest = 0;
const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
const icons = {
  Files,
  Search,
  LockKeyhole,
  Settings,
  ChevronRight,
  ChevronDown,
  FileText,
  Folder,
  FolderOpen,
  Plus,
  FolderPlus,
  RefreshCw,
  Sun,
  Moon,
  Save,
  X,
  GitBranch,
  ArrowUp,
  BookOpen,
  Code,
  PenLine,
  Bold,
  Italic,
  Heading2,
  List,
  Link,
  ImagePlus,
  Table,
  PanelLeftClose,
  ShieldCheck,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  ArrowRight,
  Ellipsis,
  Trash2,
};
const icon = (name: string) => `<i data-lucide="${name}"></i>`;
const refreshIcons = () =>
  createIcons({ icons, attrs: { "stroke-width": 1.5 } });
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  n.textContent = text;
  return n;
}
function button(
  label: string,
  action: () => unknown,
  cls = "",
  symbol?: string,
) {
  const b = el("button", cls);
  b.title = label;
  b.setAttribute("aria-label", label);
  if (symbol) b.innerHTML = icon(symbol);
  else b.textContent = label;
  b.onclick = () => {
    void Promise.resolve().then(action).catch(fail);
  };
  return b;
}
function fail(error: unknown) {
  notify(String(error), "error");
}
function notify(message: string, kind = "info") {
  const box = el("div", `toast ${kind}`);
  box.append(
    el("span", "", message),
    button("Dismiss", () => box.remove(), "icon-button", "x"),
  );
  $("#toasts").append(box);
  refreshIcons();
  setTimeout(() => box.remove(), kind === "error" ? 14000 : 6000);
}
function busy<T>(action: () => Promise<T>) {
  return action().catch(fail);
}

$("#app").innerHTML = `
 <div class="workbench"><nav class="activity" aria-label="Panels"><div class="activity-top"><button data-panel="explorer" title="Explorer (Ctrl+Shift+E)" aria-label="Explorer">${icon("files")}</button><button data-panel="search" title="Search (Ctrl+Shift+F)" aria-label="Search">${icon("search")}</button><button data-panel="git" title="Source Control (Ctrl+Shift+G)" aria-label="Source Control">${icon("git-branch")}</button><button data-panel="vault" title="Encrypted vault" aria-label="Encrypted vault">${icon("lock-keyhole")}</button></div><button data-panel="settings" title="Settings" aria-label="Settings">${icon("settings")}</button></nav>
 <aside class="sidebar"><div class="sidebar-title"><span id="panel-title">EXPLORER</span><div id="panel-actions"></div></div><div id="sidebar-content"></div><div class="sidebar-footer">${icon("shield-check")}<span>Local files. Yours to keep.</span></div></aside><div id="resize" role="separator" aria-label="Resize sidebar" tabindex="0"></div>
 <main><div class="tab-bar"><div id="tabs" role="tablist" aria-label="Open notes"></div><div id="modes" role="group" aria-label="Editor mode"><button class="icon-button" data-mode="edit" title="Edit" aria-label="Edit">${icon("pen-line")}</button><button class="icon-button" data-mode="view" title="View" aria-label="View">${icon("book-open")}</button><button class="icon-button" data-mode="code" title="Code" aria-label="Code">${icon("code")}</button></div><button id="theme" class="icon-button" title="Toggle color theme" aria-label="Toggle color theme"></button></div><div id="formatbar"></div><div id="conflict"></div><div id="editor-shell" tabindex="-1"><div id="editor"></div></div></main></div>
 <footer class="statusbar"><div><button id="git-status" title="Open Source Control">${icon("git-branch")}local</button><span id="save-status"></span></div><div><span id="word-count"></span><span>UTF-8</span><span>Markdown</span><button id="vault-status">${icon("lock-keyhole")}Vault locked</button></div></footer><div id="toasts" aria-live="polite"></div>`;

type Field = {
  key: string;
  label: string;
  value?: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
};
async function dialog(
  title: string,
  description: string,
  fields: Field[] = [],
  submit = "Continue",
  danger = false,
): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const d = el("dialog", "modal"),
      form = el("form");
    form.method = "dialog";
    form.append(
      el("div", "eyebrow", "KEIVBOOK"),
      el("h2", "", title),
      el("p", "muted", description),
    );
    for (const f of fields) {
      const l = el("label", "field", f.label),
        input = el("input");
      input.name = f.key;
      input.type = f.type || "text";
      input.value = f.value || "";
      input.placeholder = f.placeholder || "";
      input.required = f.required || false;
      input.autocomplete = "off";
      input.spellcheck = false;
      l.append(input);
      form.append(l);
    }
    const actions = el("div", "dialog-actions"),
      cancel = el("button", "secondary", "Cancel"),
      ok = el("button", danger ? "danger" : "primary", submit);
    cancel.type = "button";
    ok.type = "submit";
    actions.append(cancel, ok);
    form.append(actions);
    d.append(form);
    document.body.append(d);
    function finish(value: Record<string, string> | null) {
      form.reset();
      for (const i of form.querySelectorAll("input")) i.value = "";
      d.close();
      d.remove();
      resolve(value);
    }
    cancel.onclick = () => finish(null);
    d.oncancel = (e) => {
      e.preventDefault();
      finish(null);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      finish(
        Object.fromEntries(new FormData(form).entries()) as Record<
          string,
          string
        >,
      );
    };
    d.showModal();
    (form.querySelector("input") || ok).focus();
  });
}
async function confirm(
  title: string,
  description: string,
  submit = "Continue",
  danger = false,
) {
  return !!(await dialog(title, description, [], submit, danger));
}
function flatten(entries = tree): Entry[] {
  return entries.flatMap((e) => [e, ...flatten(e.children)]);
}
async function refreshTree() {
  tree = await api.tree();
  if (panel === "explorer") renderPanel();
}
function renderPanel() {
  $("#panel-title").textContent =
    panel === "git" ? "SOURCE CONTROL" : panel.toUpperCase();
  document
    .querySelectorAll("[data-panel]")
    .forEach((e) =>
      e.classList.toggle("active", (e as HTMLElement).dataset.panel === panel),
    );
  const host = $("#sidebar-content"),
    actions = $("#panel-actions");
  host.replaceChildren();
  actions.replaceChildren();
  if (panel === "explorer") {
    actions.append(
      button("New note", () => newEntry(false), "icon-button", "plus"),
      button("New folder", () => newEntry(true), "icon-button", "folder-plus"),
      button("Refresh Explorer", refreshTree, "icon-button", "refresh-cw"),
    );
    const root = button(
      "KEIVBOOK",
      () => {
        selected = "";
      },
      "tree-root",
    );
    root.prepend(el("span", "root-chevron", "⌄"));
    host.append(root);
    function branch(entries: Entry[], depth: number) {
      for (const e of entries) {
        const row = el(
          "div",
          `tree-row ${e.path === active?.path ? "selected" : ""}`,
        );
        row.style.paddingLeft = `${12 + depth * 16}px`;
        row.dataset.path = e.path;
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-label", e.name);
        if (e.directory)
          row.setAttribute("aria-expanded", String(expanded.has(e.path)));
        if (e.directory)
          row.append(
            button(
              expanded.has(e.path) ? "Collapse folder" : "Expand folder",
              () => {
                expanded.has(e.path)
                  ? expanded.delete(e.path)
                  : expanded.add(e.path);
                renderPanel();
              },
              "chevron",
              expanded.has(e.path) ? "chevron-down" : "chevron-right",
            ),
          );
        else row.append(el("span", "tree-spacer"));
        const name = button(
          e.name,
          async () => {
            selected = e.path;
            if (e.directory) {
              const index = e.children.find((x) => x.name === "index.md");
              if (index) await open(index.path);
              else {
                expanded.has(e.path)
                  ? expanded.delete(e.path)
                  : expanded.add(e.path);
                renderPanel();
              }
            } else if (e.path.endsWith(".md")) await open(e.path);
            else await showImage(e.path);
          },
          "tree-name",
        );
        name.prepend(
          Object.assign(el("span", "file-icon"), {
            innerHTML: icon(
              e.directory
                ? expanded.has(e.path)
                  ? "folder-open"
                  : "folder"
                : "file-text",
            ),
          }),
        );
        row.append(name);
        row.oncontextmenu = (event) => {
          event.preventDefault();
          selected = e.path;
          contextMenu(event, e);
        };
        row.draggable = true;
        row.ondragstart = (event) =>
          event.dataTransfer?.setData("application/x-keivbook-path", e.path);
        if (e.directory) {
          row.ondragover = (ev) => ev.preventDefault();
          row.ondrop = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const from = ev.dataTransfer?.getData(
              "application/x-keivbook-path",
            );
            if (from)
              void busy(() => move(from, `${e.path}/${from.split("/").pop()}`));
          };
        }
        host.append(row);
        if (e.directory && expanded.has(e.path)) branch(e.children, depth + 1);
      }
    }
    branch(tree, 0);
    if (!tree.length)
      host.append(el("p", "panel-help", "Create your first note with +."));
  } else if (panel === "search") {
    const input = el("input", "search-input");
    input.placeholder = "Search files and content";
    input.setAttribute("aria-label", "Search notes");
    host.append(input, el("div", "search-results"));
    input.oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => void searchNotes(input.value), 180);
    };
    queueMicrotask(() => input.focus());
  } else if (panel === "git") renderGitPanel(host, actions);
  else if (panel === "vault") renderVault(host);
  else {
    host.append(
      el("h3", "panel-heading", "Version control"),
      el(
        "p",
        "panel-help",
        setup?.repository
          ? "The data folder has its own Git repository."
          : "Notes are saved locally without Git.",
      ),
    );
    host.append(
      button(
        "Configure Git repository",
        () => setupDialog(true),
        "wide secondary",
        "git-branch",
      ),
    );
    if (setup) host.append(el("p", "panel-help path-label", setup.location));
    host.append(
      el("h3", "panel-heading", "Keyboard shortcuts"),
      el(
        "p",
        "panel-help shortcuts",
        "Ctrl+S    Save note\nCtrl+N    New note\nCtrl+W    Close tab\nCtrl+Shift+F    Search\nCtrl+Shift+E    Explorer\nCtrl+Shift+G    Source Control\nCtrl+Shift+L    Lock vault\nCtrl+1 / 2 / 3    Edit / View / Code",
      ),
    );
    host.append(
      el(
        "p",
        "panel-help",
        "Deleted files and prior saves are recoverable from data/.keivbook/. Backups are local and excluded from the data Git repository.",
      ),
    );
  }
  refreshIcons();
}
function setPanel(value: string) {
  panel = value;
  renderPanel();
  if (panel === "git") void refreshGit();
}
function contextMenu(event: MouseEvent, entry: Entry) {
  document.querySelector(".context-menu")?.remove();
  const menu = el("div", "context-menu");
  menu.style.left = `${Math.min(event.clientX, innerWidth - 220)}px`;
  menu.style.top = `${Math.min(event.clientY, innerHeight - 160)}px`;
  menu.append(
    button("Rename / move…", async () => {
      menu.remove();
      const r = await dialog(
        "Rename or move",
        "Enter a path relative to data. The destination folder must exist.",
        [{ key: "path", label: "Path", value: entry.path, required: true }],
        "Move",
      );
      if (r) await move(entry.path, r.path);
    }),
    button("Delete…", async () => {
      menu.remove();
      if (
        await confirm(
          "Delete this item?",
          `${entry.path} will be moved to the local recovery folder.`,
          "Delete",
          true,
        )
      ) {
        if (!(await allowDiscard(entry.path))) return;
        await api.delete(entry.path);
        tabs = tabs.filter(
          (t) => t.path !== entry.path && !t.path.startsWith(entry.path + "/"),
        );
        if (active && !tabs.includes(active)) active = tabs.at(-1);
        await refreshTree();
        renderEditor();
      }
    }),
  );
  document.body.append(menu);
  setTimeout(
    () =>
      document.addEventListener("click", () => menu.remove(), { once: true }),
    0,
  );
}
async function allowDiscard(prefix: string) {
  return (
    !tabs.some(
      (t) => (t.path === prefix || t.path.startsWith(prefix + "/")) && t.dirty,
    ) ||
    (await confirm(
      "Discard unsaved changes?",
      "This item contains notes with unsaved edits.",
      "Discard",
      true,
    ))
  );
}
async function move(from: string, to: string) {
  if (from === to) return;
  await api.rename(from, to);
  for (const t of tabs)
    if (t.path === from || t.path.startsWith(from + "/"))
      t.path = to + t.path.slice(from.length);
  expanded.add(to.split("/").slice(0, -1).join("/"));
  await refreshTree();
  renderEditor();
}
async function newEntry(folder: boolean) {
  const sel = flatten().find((e) => e.path === selected);
  const parent = sel?.directory
    ? sel.path
    : selected.split("/").slice(0, -1).join("/");
  const r = await dialog(
    folder ? "New folder" : "New note",
    "Paths are relative to your data folder.",
    [
      {
        key: "path",
        label: folder ? "Folder path" : "Note path",
        value:
          (parent ? parent + "/" : "") +
          (folder ? "new-folder" : "untitled.md"),
        required: true,
      },
    ],
    "Create",
  );
  if (!r) return;
  await api.create(r.path, folder);
  expanded.add(parent);
  await refreshTree();
  if (!folder) await open(r.path);
}
async function searchNotes(query: string) {
  const host = $(".search-results");
  if (!host) return;
  host.replaceChildren();
  if (!query.trim()) return;
  const needle = query.toLocaleLowerCase();
  let count = 0;
  for (const e of flatten().filter(
    (e) => !e.directory && e.path.endsWith(".md"),
  )) {
    try {
      const content =
        tabs.find((t) => t.path === e.path)?.content ??
        (await api.read(e.path)).content;
      const lines = content.split("\n");
      const line = lines.findIndex((l) =>
        l.toLocaleLowerCase().includes(needle),
      );
      if (line >= 0 || e.path.toLocaleLowerCase().includes(needle)) {
        const b = button(e.name, () => open(e.path), "search-result");
        b.append(
          el("small", "", e.path),
          el(
            "p",
            "",
            line >= 0
              ? `${line + 1}: ${lines[line].slice(0, 160)}`
              : "Filename match",
          ),
        );
        host.append(b);
        count++;
      }
    } catch {
      /* A disappearing file is handled by the watcher. */
    }
  }
  if (!count) host.append(el("p", "panel-help", "No matching notes."));
}
function destroyEditor() {
  if (renderedTab) renderedTab.scroll = $("#editor-shell").scrollTop;
  renderedTab = undefined;
  rich?.destroy();
  code?.destroy();
  rich = undefined;
  code = undefined;
  for (const url of urls) URL.revokeObjectURL(url);
  urls = [];
}
async function open(path: string) {
  let tab = tabs.find((t) => t.path === path);
  if (!tab) {
    const d = await api.read(path);
    tab = {
      path,
      ...d,
      dirty: false,
      conflict: false,
      mode: "edit",
      scroll: 0,
      cursor: 0,
    };
    tabs.push(tab);
  }
  destroyEditor();
  active = tab;
  selected = path;
  const parts = path.split("/");
  parts.pop();
  while (parts.length) {
    expanded.add(parts.join("/"));
    parts.pop();
  }
  renderEditor();
  focusEditor();
  if (panel === "explorer") renderPanel();
}
function focusEditor() {
  if (rich) rich.view.focus();
  else if (code) code.focus();
  else if (active) $("#editor-shell").focus();
}
function changed(content: string) {
  if (!active) return;
  active.content = content;
  if (!active.dirty) {
    active.dirty = true;
    renderTabs();
  }
  status();
}
function renderTabs() {
  const host = $("#tabs");
  host.replaceChildren();
  for (const t of tabs) {
    const row = el(
      "div",
      `tab${active === t ? " active" : ""}${t.dirty ? " dirty" : ""}`,
    );
    row.setAttribute("role", "tab");
    row.setAttribute("aria-selected", String(active === t));
    const b = button(t.path.split("/").pop()!, () => open(t.path), "tab-label");
    b.title = t.path;
    b.prepend(Object.assign(el("span", ""), { innerHTML: icon("file-text") }));
    if (t.dirty) row.setAttribute("aria-label", `${t.path}, unsaved changes`);
    const close = button(
      `Close ${t.path}`,
      () => closeTab(t),
      "tab-close",
      "x",
    );
    close.append(el("span", "dirty-dot"));
    row.append(b, close);
    host.append(row);
  }
  refreshIcons();
}
async function closeTab(t: Tab) {
  if (
    t.dirty &&
    !(await confirm(
      "Close unsaved note?",
      `${t.path} has unsaved changes.`,
      "Discard",
      true,
    ))
  )
    return;
  destroyEditor();
  tabs = tabs.filter((x) => x !== t);
  if (active === t) active = tabs.at(-1);
  renderEditor();
}
function status() {
  $("#save-status").textContent = active
    ? active.conflict
      ? "External changes detected"
      : active.dirty
        ? "Unsaved changes"
        : "All changes saved"
    : "Ready";
  $("#word-count").textContent = active
    ? `${active.content.trim().split(/\s+/).filter(Boolean).length} words`
    : "";
  $("#vault-status").innerHTML =
    icon(session ? "shield-check" : "lock-keyhole") +
    (session ? "Vault unlocked" : "Vault locked");
  refreshIcons();
}
function renderEditor() {
  destroyEditor();
  renderedTab = active;
  renderTabs();
  const host = $("#editor");
  host.replaceChildren();
  $("#formatbar").replaceChildren();
  $("#conflict").replaceChildren();
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => {
    const current = b.dataset.mode === active?.mode;
    b.classList.toggle("active", current);
    b.setAttribute("aria-pressed", String(current));
    b.disabled = !active;
  });
  if (!active) {
    host.innerHTML = `<div class="empty-state">${icon("book-open")}<h1>A place for your thoughts.</h1><p>Open a note from the Explorer, or start something new.</p><div class="empty-shortcut"><span>New note</span><kbd>Ctrl N</kbd></div><div class="empty-shortcut"><span>Find a thought</span><kbd>Ctrl Shift F</kbd></div></div>`;
    status();
    return;
  }
  const tab = active;
  if (tab.conflict) {
    const banner = el("div", "conflict-banner");
    banner.append(
      el("span", "", "This file changed on disk. Your edits are still here."),
      button("Reload disk version", reloadCurrent, "secondary"),
      button("Save a copy", saveCopy, "secondary"),
    );
    $("#conflict").append(banner);
  }
  host.className = tab.mode === "code" ? "source-editor" : "document-editor";
  if (tab.mode === "code") {
    code = new EditorView({
      doc: tab.content,
      extensions: [
        basicSetup,
        markdown(),
        ...(theme === "dark" ? [oneDark] : []),
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) changed(u.state.doc.toString());
          if (u.selectionSet) tab.cursor = u.state.selection.main.head;
        }),
      ],
      parent: host,
    });
    code.dispatch({
      selection: { anchor: Math.min(tab.cursor, tab.content.length) },
    });
  } else if (tab.mode === "view") {
    host.innerHTML = renderMarkdown(tab.content);
    void hydrate(host, tab);
    addHeadingFolds(host);
  } else {
    rich = new Editor({
      element: host,
      extensions: [
        StarterKit.configure({ link: { openOnClick: false, autolink: false } }),
        localImage(tab.path),
        VaultReference,
        TableKit,
        Markdown,
      ],
      content: tab.content,
      contentType: "markdown",
      editorProps: {
        attributes: { spellcheck: "true", "aria-label": "Markdown editor" },
        handleDOMEvents: {
          drop: (_view, e) => {
            if (e.dataTransfer?.files.length) {
              e.preventDefault();
              e.stopPropagation();
              void busy(() => dropImages(e.dataTransfer!.files));
              return true;
            }
            return false;
          },
        },
      },
      onUpdate: ({ editor }) =>
        changed(preserveTypedReferences(editor.getMarkdown())),
    });
    if (tab.cursor > 0 && tab.cursor <= rich.state.doc.content.size)
      rich.commands.setTextSelection(tab.cursor);
    rich.on("selectionUpdate", ({ editor }) => {
      tab.cursor = editor.state.selection.from;
    });
    // A rich editor cannot losslessly represent every Markdown dialect. Keep such files in Code.
    if (renderMarkdown(rich.getMarkdown()) !== renderMarkdown(tab.content)) {
      tab.mode = "code";
      renderEditor();
      notify("This note contains syntax that needs Code mode to preserve it.");
      return;
    }
    makeFormatbar();
  }
  $("#editor-shell").scrollTop = tab.scroll;
  status();
}
function makeFormatbar() {
  const bar = $("#formatbar");
  bar.append(
    button(
      "Bold",
      () => rich?.chain().focus().toggleBold().run(),
      "icon-button",
      "bold",
    ),
    button(
      "Italic",
      () => rich?.chain().focus().toggleItalic().run(),
      "icon-button",
      "italic",
    ),
    button(
      "Heading",
      () => rich?.chain().focus().toggleHeading({ level: 2 }).run(),
      "icon-button",
      "heading-2",
    ),
    button(
      "Bullet list",
      () => rich?.chain().focus().toggleBulletList().run(),
      "icon-button",
      "list",
    ),
    button(
      "Insert link",
      async () => {
        const r = await dialog(
          "Insert a link",
          "Use a relative note path or an HTTPS address.",
          [
            {
              key: "url",
              label: "Destination",
              placeholder: "notes/ideas.md",
              required: true,
            },
          ],
          "Insert",
        );
        if (
          r &&
          (/^(https?:\/\/)/.test(r.url) || resolveLink(active!.path, r.url))
        )
          rich?.chain().focus().setLink({ href: r.url }).run();
      },
      "icon-button",
      "link",
    ),
    button("Insert image", pickImages, "icon-button", "image-plus"),
    button(
      "Insert table",
      () =>
        rich
          ?.chain()
          .focus()
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
      "icon-button",
      "table",
    ),
  );
  bar.append(
    el("span", "format-hint", "Markdown, without the markup"),
    button("Save (Ctrl+S)", save, "save-button", "save"),
  );
  refreshIcons();
}
async function save() {
  if (!active || !active.dirty) return;
  const tab = active,
    content = tab.content;
  if (saving.has(tab)) return;
  saving.add(tab);
  try {
    tab.revision = await api.write(tab.path, content, tab.revision);
    tab.dirty = tab.content !== content;
    tab.conflict = false;
    renderTabs();
    status();
    if (active === tab) $("#conflict").replaceChildren();
    if (panel === "git") void refreshGit();
  } catch (e) {
    if (String(e).includes("CONFLICT")) {
      tab.conflict = true;
      renderEditor();
    }
    throw e;
  } finally {
    saving.delete(tab);
  }
}
async function saveCopy() {
  if (!active) return;
  const r = await dialog(
    "Save a copy",
    "Keep your edits in a separate note.",
    [
      {
        key: "path",
        label: "Path",
        value: active.path.replace(/\.md$/, "-copy.md"),
        required: true,
      },
    ],
    "Save copy",
  );
  if (r) {
    await api.write(r.path, active.content, null);
    await refreshTree();
    await open(r.path);
  }
}
async function reloadCurrent() {
  if (!active) return;
  if (
    active.dirty &&
    !(await confirm(
      "Reload from disk?",
      "Your unsaved edits will be discarded.",
      "Reload",
      true,
    ))
  )
    return;
  const d = await api.read(active.path);
  Object.assign(active, d, { dirty: false, conflict: false });
  renderEditor();
}
function setMode(mode: Mode) {
  if (active) {
    active.mode = mode;
    renderEditor();
  }
}
function toggleTheme() {
  theme = theme === "dark" ? "light" : "dark";
  applyTheme();
  renderEditor();
}
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("keivbook.theme", theme);
  $("#theme").innerHTML = icon(theme === "dark" ? "sun" : "moon");
  if ("__TAURI_INTERNALS__" in window) {
    void getCurrentWindow()
      .setTheme(theme === "dark" ? "dark" : "light")
      .catch(fail);
  }
  refreshIcons();
}
async function hydrateImages(host: HTMLElement, note: string) {
  for (const img of host.querySelectorAll("img")) {
    const src = img.getAttribute("src") || "";
    if (src.startsWith("blob:")) continue;
    const resolved = resolveLink(note, src);
    img.removeAttribute("src");
    if (!resolved) {
      img.alt = "External images are disabled";
      continue;
    }
    try {
      const bytes = await api.asset(resolved.path);
      if (!host.isConnected) return;
      const ext = resolved.path.split(".").pop()?.toLowerCase();
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], {
          type: `image/${ext === "jpg" ? "jpeg" : ext}`,
        }),
      );
      urls.push(url);
      img.src = url;
      img.dataset.localPath = src;
    } catch {
      img.alt = `Missing image: ${src}`;
    }
  }
}
async function hydrate(host: HTMLElement, tab: Tab) {
  await hydrateImages(host, tab.path);
  if (active !== tab || tab.mode !== "view") return;
  for (const a of host.querySelectorAll("a")) {
    const href = a.getAttribute("href") || "";
    a.removeAttribute("href");
    a.tabIndex = 0;
    a.setAttribute("role", "link");
    a.title = href;
    const go = () => {
      const target = resolveLink(tab.path, href);
      if (target)
        void busy(async () => {
          if (target.path !== active?.path)
            await open(
              target.path.endsWith(".md")
                ? target.path
                : target.path.replace(/\/$/, "") + "/index.md",
            );
          if (target.hash) {
            setMode("view");
            document
              .getElementById(headingId(decodeURIComponent(target.hash)))
              ?.scrollIntoView();
          }
        });
      else
        notify(
          "External links are shown as text. Copy the address from the link title.",
        );
    };
    a.onclick = go;
    a.onkeydown = (e) => {
      if (e.key === "Enter") go();
    };
  }
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const n = walker.currentNode as Text;
    if (
      !n.parentElement?.closest("code,pre") &&
      n.textContent?.includes("{{vault.")
    )
      nodes.push(n);
  }
  for (const text of nodes) {
    const value = text.data;
    const frag = document.createDocumentFragment();
    let start = 0;
    for (const match of value.matchAll(/\{\{vault\.([a-zA-Z0-9_.-]+)\}\}/g)) {
      frag.append(document.createTextNode(value.slice(start, match.index)));
      const key = match[1],
        chip = el("span", "vault-chip"),
        display = el("span", "", "••••••••");
      chip.title = key;
      const exists = vaultKeys.includes(key);
      if (!exists) display.textContent = `Missing: ${key}`;
      else if (!session) display.textContent = `Locked · ${key}`;
      chip.append(display);
      if (session && exists) {
        let revealed = false;
        chip.append(
          button(
            "Show / hide value",
            () => {
              revealed = !revealed;
              display.textContent = revealed
                ? (session?.values[key] ?? "Locked")
                : "••••••••";
            },
            "icon-button",
            "eye",
          ),
          button("Copy value", () => copySecret(key), "icon-button", "copy"),
          button("Edit value", () => editValue(key), "icon-button", "pen-line"),
        );
      }
      frag.append(chip);
      start = match.index! + match[0].length;
    }
    frag.append(document.createTextNode(value.slice(start)));
    text.replaceWith(frag);
  }
  refreshIcons();
}
function addHeadingFolds(host: HTMLElement) {
  const used = new Map<string, number>();
  for (const h of host.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")) {
    const base = headingId(h.textContent || "");
    const n = used.get(base) || 0;
    used.set(base, n + 1);
    h.id = base + (n ? `-${n}` : "");
    const b = button(
      "Collapse heading",
      () => {
        const collapsed = b.getAttribute("aria-expanded") === "false";
        b.setAttribute("aria-expanded", String(collapsed));
        b.textContent = collapsed ? "⌄" : "›";
        let next = h.nextElementSibling as HTMLElement | null;
        while (
          next &&
          !(/^H[1-6]$/.test(next.tagName) && next.tagName <= h.tagName)
        ) {
          next.hidden = !collapsed;
          next = next.nextElementSibling as HTMLElement | null;
        }
      },
      "heading-fold",
    );
    b.textContent = "⌄";
    b.setAttribute("aria-expanded", "true");
    h.prepend(b);
  }
}
async function showImage(path: string) {
  const bytes = await api.asset(path),
    url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
  const d = el("dialog", "image-dialog"),
    img = el("img");
  img.src = url;
  img.alt = path;
  d.append(
    img,
    button("Close", () => d.close(), "secondary"),
  );
  d.onclose = () => {
    URL.revokeObjectURL(url);
    d.remove();
  };
  document.body.append(d);
  d.showModal();
}
function pickImages() {
  const input = el("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/gif,image/webp,image/bmp";
  input.multiple = true;
  input.onchange = () => {
    if (input.files) void busy(() => dropImages(input.files!));
  };
  input.click();
}
async function dropImages(files: FileList) {
  if (!active || active.mode === "view") return;
  const tab = active;
  for (const f of files) {
    if (f.size > 20 * 1024 * 1024)
      throw Error("Images must be smaller than 20 MiB");
    const path = await api.importImage(
      f.name,
      Array.from(new Uint8Array(await f.arrayBuffer())),
    );
    if (active !== tab)
      throw Error("Image imported. Return to the original note to insert it.");
    const src = relativePath(tab.path, path);
    if (rich) {
      rich
        .chain()
        .focus()
        .setImage({ src, alt: f.name.replace(/[\[\]]/g, "") })
        .run();
    } else if (code) {
      code.dispatch(
        code.state.replaceSelection(
          `![${f.name.replace(/[\[\]]/g, "")}](${src})`,
        ),
      );
    }
  }
  await refreshTree();
}

async function refreshVault() {
  const d = await api.vault();
  const changed = (d?.revision ?? null) !== vaultRevision;
  if (changed && session) lockVault();
  vaultRaw = d?.content ?? null;
  vaultRevision = d?.revision ?? null;
  vaultKeys = d ? parseEnvelope(d.content).keys : [];
  if (changed && active?.mode === "view") renderEditor();
  if (panel === "vault") renderPanel();
}
function renderVault(host: HTMLElement) {
  const hero = el("div", "vault-hero");
  hero.innerHTML = icon(session ? "shield-check" : "lock-keyhole");
  hero.append(
    el(
      "h3",
      "",
      session
        ? "Vault is unlocked"
        : vaultRaw
          ? "A little extra privacy."
          : "Your secrets belong here.",
    ),
    el(
      "p",
      "muted",
      session
        ? "Values stay in memory until you lock."
        : "AES-256-GCM encryption. Your master password never leaves this window.",
    ),
  );
  host.append(hero);
  if (!session) {
    host.append(
      button(
        vaultRaw ? "Unlock vault" : "Create encrypted vault",
        unlockVault,
        "wide primary",
      ),
    );
    if (vaultKeys.length)
      host.append(el("h3", "panel-heading", `${vaultKeys.length} variables`));
    for (const k of vaultKeys) host.append(el("div", "locked-key", k));
  } else {
    host.append(
      button("Add variable", () => editValue(), "wide primary", "plus"),
    );
    for (const key of vaultKeys) {
      const row = el("div", "vault-row");
      row.append(
        el("span", "vault-key", key),
        el("span", "secret-mask", "••••••••"),
      );
      const actions = el("div", "vault-actions");
      actions.append(
        button("Copy value", () => copySecret(key), "icon-button", "copy"),
        button(
          "Edit variable",
          () => editValue(key),
          "icon-button",
          "pen-line",
        ),
        button(
          "Delete variable",
          () => deleteValue(key),
          "icon-button",
          "trash-2",
        ),
      );
      row.append(actions);
      host.append(row);
    }
    host.append(
      button("Lock vault", lockVault, "wide secondary", "lock-keyhole"),
      button(
        "Change master password",
        changePassword,
        "wide secondary",
        "key-round",
      ),
    );
  }
  host.append(
    button("Check variable references", auditVault, "wide secondary"),
    el(
      "p",
      "panel-help",
      "Reference a value with {{vault.personal.password}}. View mode provides Show, Copy, and Edit controls. Locks after 5 minutes of inactivity.",
    ),
  );
  if (vaultBusy) host.append(el("p", "panel-help", "Securing your vault…"));
}
async function vaultOperation(work: () => Promise<void>) {
  if (vaultBusy) {
    notify("A vault operation is already in progress.");
    return;
  }
  vaultBusy = true;
  try {
    await work();
  } finally {
    vaultBusy = false;
    await refreshVault().catch(fail);
    if (panel === "vault") renderPanel();
    status();
  }
}
async function unlockVault() {
  await vaultOperation(async () => {
    await refreshVault();
    const epoch = vaultEpoch;
    const exists = !!vaultRaw;
    const fields: Field[] = [
      {
        key: "password",
        label: "Master password",
        type: "password",
        required: true,
      },
    ];
    if (!exists)
      fields.push({
        key: "confirm",
        label: "Confirm master password",
        type: "password",
        required: true,
      });
    const r = await dialog(
      exists ? "Unlock your vault" : "Create your vault",
      exists
        ? "Enter the master password for this vault."
        : "Use at least 10 characters. There is no password reset.",
      fields,
      exists ? "Unlock" : "Create vault",
    );
    if (!r) return;
    try {
      if (exists) {
        const next = await unlock(vaultRaw!, r.password);
        if (epoch === vaultEpoch && !document.hidden) session = next;
      } else {
        if (r.password !== r.confirm) throw Error("Passwords do not match");
        const next = await createSession(r.password);
        await persistVault(next, epoch);
        if (epoch === vaultEpoch && !document.hidden) session = next;
      }
    } finally {
      r.password = "";
      r.confirm = "";
    }
    lastActivity = Date.now();
    renderEditor();
  });
}
async function persistVault(next: Session, epoch: number) {
  if (epoch !== vaultEpoch)
    throw Error("Vault was locked. Unlock it to continue.");
  const envelope = await encrypt(next),
    raw = JSON.stringify(envelope, null, 2);
  if (epoch !== vaultEpoch)
    throw Error("Vault was locked. Unlock it to continue.");
  vaultRevision = await api.writeVault(raw, vaultRevision);
  vaultRaw = raw;
  vaultKeys = envelope.keys;
}
function lockVault() {
  vaultEpoch++;
  if (session) {
    for (const key of Object.keys(session.values)) session.values[key] = "";
  }
  session = null;
  document
    .querySelectorAll("input[type=password]")
    .forEach((input) => ((input as HTMLInputElement).value = ""));
  if (panel === "vault") renderPanel();
  renderEditor();
  status();
}
async function editValue(key?: string) {
  if (!session) {
    setPanel("vault");
    return;
  }
  await vaultOperation(async () => {
    const current = session;
    if (!current) return;
    const epoch = vaultEpoch;
    const r = await dialog(
      key ? "Edit variable" : "Add a variable",
      "Only the encrypted vault is saved. The note keeps its placeholder.",
      [
        {
          key: "key",
          label: "Variable name",
          value: key || "",
          placeholder: "personal.password",
          required: true,
        },
        {
          key: "value",
          label: "Secret value",
          type: "password",
          value: key ? current.values[key] : "",
          required: true,
        },
      ],
      "Save value",
    );
    if (!r) return;
    try {
      if (session !== current)
        throw Error("Vault was locked. Unlock it to continue.");
      if (!validKey(r.key))
        throw Error("Use a dotted key such as personal.password");
      if (r.key !== key && Object.hasOwn(current.values, r.key))
        throw Error("That variable already exists");
      const next = { ...current, values: { ...current.values } };
      if (key) delete next.values[key];
      next.values[r.key] = r.value;
      await persistVault(next, epoch);
      if (epoch === vaultEpoch) session = next;
      renderEditor();
    } finally {
      r.value = "";
    }
  });
}
async function deleteValue(key: string) {
  if (!session) return;
  await vaultOperation(async () => {
    const epoch = vaultEpoch;
    if (
      !(await confirm(
        "Delete variable?",
        `${key} will be removed. Existing note references will be reported as missing.`,
        "Delete",
        true,
      ))
    )
      return;
    if (!session) return;
    const next = { ...session, values: { ...session.values } };
    delete next.values[key];
    await persistVault(next, epoch);
    if (epoch === vaultEpoch) session = next;
    renderEditor();
  });
}
async function changePassword() {
  await vaultOperation(async () => {
    const current = session;
    if (!current) return;
    const epoch = vaultEpoch;
    const r = await dialog(
      "Change master password",
      "Previous Git versions still require their original password.",
      [
        {
          key: "password",
          label: "New master password",
          type: "password",
          required: true,
        },
        {
          key: "confirm",
          label: "Confirm new password",
          type: "password",
          required: true,
        },
      ],
      "Change password",
    );
    if (!r) return;
    try {
      if (r.password !== r.confirm) throw Error("Passwords do not match");
      if (session !== current) throw Error("Vault was locked");
      const next = await createSession(r.password, { ...current.values });
      await persistVault(next, epoch);
      if (epoch === vaultEpoch) session = next;
      notify("Master password changed.");
    } finally {
      r.password = "";
      r.confirm = "";
    }
  });
}
async function copySecret(key: string) {
  if (!session) return;
  await navigator.clipboard.writeText(session.values[key]);
  notify("Value copied to the clipboard.");
}
async function auditVault() {
  const notes: string[] = [];
  for (const e of flatten().filter((e) => e.path.endsWith(".md")))
    notes.push(
      tabs.find((t) => t.path === e.path)?.content ??
        (await api.read(e.path)).content,
    );
  const report = auditReferences(notes, vaultKeys);
  await dialog(
    "Variable references",
    `Missing: ${report.missing.join(", ") || "none"}\n\nUnused: ${report.unused.join(", ") || "none"}`,
    [],
    "Done",
  );
}
async function setupDialog(force = false) {
  setup = await api.setup();
  if (setup.configured && !force) return;
  const r = await dialog(
    setup.repository ? "Data repository found" : "Version your notes with Git",
    "Use an independent Git repository for your notes. Add an optional origin remote to push from Source Control.",
    [
      {
        key: "remote",
        label: "Remote repository (optional)",
        value: setup.remote || "",
        placeholder: "https://github.com/you/private-notes.git",
      },
    ],
    setup.repository ? "Save Git settings" : "Create repository",
  );
  if (r) setup = await api.configure(true, r.remote || null);
  else if (!force) {
    if (
      await confirm(
        "Continue without Git?",
        "You can configure a repository later from Source Control or Settings.",
        "Continue locally",
      )
    )
      setup = await api.configure(false, null);
    else return setupDialog();
  }
  updateGit();
  if (panel === "settings" || panel === "git") renderPanel();
  if (panel === "git") void refreshGit();
}
function updateGit() {
  $("#git-status").innerHTML = icon("git-branch");
  $("#git-status").append(
    setup?.repository ? (gitStatus?.branch ?? "data · Git") : "local",
  );
  refreshIcons();
}
function renderGitPanel(host: HTMLElement, actions: HTMLElement) {
  const configure = () => setupDialog(true);
  if (!setup?.repository) {
    host.append(
      el("p", "panel-help", "Set up Git to commit and push your notes."),
      button("Configure Git repository", configure, "wide primary"),
    );
    return;
  }
  actions.append(
    button("Refresh Git status", refreshGit, "icon-button", "refresh-cw"),
    button("Git settings", configure, "icon-button", "settings"),
  );
  const form = el("form", "git-form");
  const message = el("input");
  message.id = "commit-message";
  message.setAttribute("aria-label", "Commit message");
  message.placeholder = "Commit message";
  message.autocomplete = "off";
  message.value = gitMessage;
  message.oninput = () => {
    gitMessage = message.value;
    updateGitButtons();
  };
  const controls = el("div", "git-controls");
  const commit = el("button", "primary", "Commit");
  commit.id = "git-commit";
  commit.type = "submit";
  commit.prepend(
    Object.assign(el("span", "git-icon"), { innerHTML: icon("check") }),
  );
  const push = button("Push", () => runGitAction(false), "secondary");
  push.id = "git-push";
  push.type = "button";
  push.prepend(
    Object.assign(el("span", "git-icon"), { innerHTML: icon("arrow-up") }),
  );
  controls.append(commit, push);
  form.append(message, controls);
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!commit.disabled) void runGitAction(true);
  };
  const changes = el("div");
  changes.id = "git-changes";
  host.append(form, changes);
  renderGitChanges();
}
function updateGitButtons() {
  const commit = document.querySelector<HTMLButtonElement>("#git-commit");
  const push = document.querySelector<HTMLButtonElement>("#git-push");
  if (!commit || !push) return;
  commit.disabled = gitBusy || !gitMessage.trim() || !gitStatus?.changes.length;
  push.disabled = gitBusy || !gitStatus?.can_push;
  push.title = setup?.remote
    ? gitStatus?.can_push
      ? "Push to origin"
      : "Create a commit on a branch to push"
    : "Set an origin remote in Git settings";
}
function renderGitChanges() {
  const host = document.querySelector("#git-changes");
  if (!host) return;
  updateGitButtons();
  host.replaceChildren();
  if (gitBusy || gitError || !gitStatus?.changes.length) {
    host.append(
      el(
        "p",
        "panel-help",
        gitBusy
          ? "Working…"
          : gitError ||
              (gitStatus ? "No saved changes." : "Loading Git status…"),
      ),
    );
    return;
  }
  const staged = gitStatus.changes.some(
    ({ index }) => index !== " " && index !== "?",
  );
  host.append(
    el(
      "p",
      "panel-help",
      staged
        ? "Commit includes staged changes."
        : "Commit includes all saved changes.",
    ),
  );
  const list = el("ul", "git-changes");
  for (const change of gitStatus.changes) {
    const row = el("li", "git-change");
    const path = el("span", "git-path", change.path);
    path.title = change.path;
    const flags = (change.index + change.worktree).trim();
    row.append(path, el("span", "git-flags", flags === "??" ? "U" : flags));
    list.append(row);
  }
  host.append(list);
}
async function refreshGit() {
  if (!setup?.repository || gitBusy) return;
  const request = ++gitRequest;
  try {
    const status = await api.gitStatus();
    if (request !== gitRequest) return;
    gitStatus = status;
    gitError = "";
  } catch (error) {
    if (request !== gitRequest) return;
    gitStatus = undefined;
    gitError = String(error);
  }
  updateGit();
  renderGitChanges();
}
async function runGitAction(commit: boolean) {
  if (gitBusy) return;
  gitBusy = true;
  ++gitRequest;
  renderGitChanges();
  try {
    if (commit) {
      const message = gitMessage;
      await api.gitCommit(message.trim());
      if (gitMessage === message) {
        gitMessage = defaultCommitMessage;
        const field =
          document.querySelector<HTMLInputElement>("#commit-message");
        if (field) field.value = gitMessage;
      }
      notify("Changes committed.");
    } else {
      await api.gitPush();
      notify("Pushed to origin.");
    }
  } catch (error) {
    fail(error);
  } finally {
    gitBusy = false;
    await refreshGit();
  }
}
async function externalChanges() {
  await refreshTree();
  for (const t of tabs) {
    try {
      const revision = t.revision;
      const d = await api.read(t.path);
      if (t.revision !== revision || saving.has(t)) continue;
      if (d.revision !== t.revision) {
        if (t.dirty) {
          t.conflict = true;
        } else {
          Object.assign(t, d);
        }
        if (active === t) renderEditor();
      }
    } catch {
      t.conflict = true;
      if (active === t) renderEditor();
    }
  }
  if (!vaultBusy) await refreshVault();
  status();
  if (panel === "git") void refreshGit();
}

document
  .querySelectorAll<HTMLElement>("[data-panel]")
  .forEach((b) => (b.onclick = () => setPanel(b.dataset.panel!)));
document
  .querySelectorAll<HTMLElement>("[data-mode]")
  .forEach((b) => (b.onclick = () => setMode(b.dataset.mode as Mode)));
$("#theme").onclick = toggleTheme;
$("#git-status").onclick = () => setPanel("git");
$("#vault-status").onclick = () => setPanel("vault");
window.addEventListener(
  "keydown",
  (e) => {
    lastActivity = Date.now();
    if (document.querySelector("dialog[open]")) return;
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "s" || e.code === "KeyS") {
        e.preventDefault();
        e.stopPropagation();
        void busy(save);
      } else if (k === "n") {
        e.preventDefault();
        void busy(() => newEntry(false));
      } else if (k === "w") {
        e.preventDefault();
        if (active) void busy(() => closeTab(active!));
      } else if (e.shiftKey && k === "f") {
        e.preventDefault();
        setPanel("search");
      } else if (e.shiftKey && k === "e") {
        e.preventDefault();
        setPanel("explorer");
      } else if (e.shiftKey && k === "g") {
        e.preventDefault();
        setPanel("git");
      } else if (e.shiftKey && k === "l") {
        e.preventDefault();
        lockVault();
      } else if (["1", "2", "3"].includes(k)) {
        e.preventDefault();
        setMode((["edit", "view", "code"] as Mode[])[Number(k) - 1]);
      }
    }
  },
  { capture: true },
);
document.addEventListener("pointerdown", () => (lastActivity = Date.now()));
setInterval(() => {
  if (session && Date.now() - lastActivity > 5 * 60 * 1000) lockVault();
}, 15000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden && (session || vaultBusy)) lockVault();
});
$("#editor-shell").ondragover = (e) => e.preventDefault();
$("#editor-shell").ondrop = (e) => {
  if (e.dataTransfer?.files.length) {
    e.preventDefault();
    void busy(() => dropImages(e.dataTransfer!.files));
  }
};
const resize = $("#resize");
resize.onpointerdown = (e) => {
  resize.setPointerCapture(e.pointerId);
};
resize.onpointermove = (e) => {
  if (resize.hasPointerCapture(e.pointerId))
    document.documentElement.style.setProperty(
      "--sidebar-width",
      `${Math.max(190, Math.min(480, e.clientX - 48))}px`,
    );
};
resize.onkeydown = (e) => {
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    const width = $(".sidebar").offsetWidth;
    document.documentElement.style.setProperty(
      "--sidebar-width",
      `${Math.max(190, Math.min(480, width + (e.key === "ArrowLeft" ? -10 : 10)))}px`,
    );
  }
};
applyTheme();
renderPanel();
renderEditor();
async function start() {
  await refreshTree();
  await refreshVault().catch(fail);
  setup = await api.setup();
  updateGit();
  if (flatten().some((e) => e.path === "index.md")) await open("index.md");
  await listen("data-changed", () => {
    clearTimeout(watcherTimer);
    watcherTimer = setTimeout(() => void busy(externalChanges), 400);
  });
  await getCurrentWindow().onCloseRequested(async (event) => {
    event.preventDefault();
    if (
      tabs.some((t) => t.dirty) &&
      !(await confirm(
        "Close KeivBook?",
        "There are unsaved notes. Cancel and press Ctrl+S to save them.",
        "Discard and close",
        true,
      ))
    )
      return;
    lockVault();
    await getCurrentWindow().destroy();
  });
  await setupDialog();
  focusEditor();
}
void start().catch(fail);
