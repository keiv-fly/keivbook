# KeivBook

A portable Windows 11 Markdown notebook built with Tauri 2, Rust, and TypeScript. Includes VS Code inspired **Dark+ and Light+** themes, a file Explorer, three editing modes, and a frontend-encrypted password vault.

## Run

Double-click **`keivbook.exe` in the project root**. It creates `data/index.md` beside the executable and opens the first-run Git setup dialog. You can:

- Create an independent repository in `data/` and optionally set its `origin` remote.
- Cancel and choose **Continue locally**, then configure Git later from Settings.

Git initialization is built into the executable. Install Git for Windows and make sure `git` is on PATH to use the Source Control panel. Commits use your Git name and email, and pushes use your existing Git credentials or SSH configuration. Choose a private remote because note text and vault key names are unencrypted.

Move `keivbook.exe` and `data/` together to move the notebook. Keep them in a writable local directory. All frontend assets are embedded in the executable. Editing works offline. Push connects to the configured Git remote. Node and Rust are needed only to build from source.

Windows 11's WebView2 runtime is required. For a machine without it, distribute Microsoft's extracted **x64 Fixed Version WebView2 runtime** in `webview2/` next to `keivbook.exe`, with `webview2/msedgewebview2.exe` directly inside that directory. KeivBook detects it automatically. The runtime binaries are not included in this repository. See [Microsoft's runtime distribution guide](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution) and [Tauri's WebView2 packaging documentation](https://v2.tauri.app/distribute/windows-installer/#webview2-installation-options).

## Build from source

Prerequisites: Node.js 22 or newer, Rust stable with the `x86_64-pc-windows-msvc` target, Visual Studio C++ Build Tools, Windows SDK, and WebView2. Dependency installation needs network access; subsequent locked builds can use the downloaded caches.

```powershell
npm ci
npm run package
```

Or run `./build.ps1`. The packaging command invokes **`tauri build --no-bundle`** and copies the optimized binary to **`./keivbook.exe`**. Separate `keivbook.pdb` symbols are copied to the root when emitted by MSVC; they are optional for distribution. A direct `cargo tauri build --no-bundle` (with the Cargo Tauri CLI installed) produces the same release binary under `src-tauri/target/release`; run `node scripts/package.mjs` afterward to copy it to the root.

```powershell
npm run desktop       # Native development window
npm run build         # Type-check and compile frontend assets only
npm test              # Frontend unit tests
npm run test:rust     # Rust filesystem and repository tests
npm run test:ui       # Headless Edge workflow tests with synthetic data
```

`npm run dev` serves only the frontend for development. The actual filesystem API requires the native application. Browser workflow tests supply an isolated IPC mock; they do not touch your real notes or vault. Rust tests use temporary directories, including a real Windows junction to test escape rejection.

## Use the notebook

- Click a folder name to open its `index.md`; its chevron controls expansion.
- Use Explorer **+** / **New folder**, or right-click an entry to rename, move, or delete it. Moving also accepts a new relative path; drag entries onto folders to move them.
- **Edit** provides headings, lists, links, tables, and images with TipTap. **View** provides safe rendering, internal links, heading folds, and vault controls. **Code** provides CodeMirror Markdown editing.
- Drop PNG, JPEG, GIF, WebP, or BMP images into Edit or Code mode. Images are copied into `data/images/` and inserted with relative paths. SVG and remotely hosted images are intentionally not loaded.
- Search scans note names and contents. Tabs keep unsaved changes while switching notes and modes. Save explicitly with **Ctrl+S**.
- Open **Source Control** to see changes in `data/`. **Commit** starts with the message `a1` and records staged changes if there are any, or all saved changes otherwise. **Push** sends committed changes from the current branch to the same branch on `origin`.
- External changes reload clean notes. If a note has unsaved edits, the conflict banner offers **Reload disk version** or **Save a copy**. A stale save cannot silently overwrite another revision.
- Toggle the sun/moon button for Light+ or Dark+. Drag the Explorer divider to resize it.

| Shortcut | Action |
| --- | --- |
| Ctrl+S | Save the active note |
| Ctrl+N | New note |
| Ctrl+W | Close the active tab |
| Ctrl+Shift+E | Explorer |
| Ctrl+Shift+F | Search |
| Ctrl+Shift+G | Source Control |
| Ctrl+Shift+L | Lock vault |
| Ctrl+1 / Ctrl+2 / Ctrl+3 | Edit / View / Code |

Rich editing supports the Markdown constructs represented by the configured TipTap extensions. A note whose rendered Markdown would change during parsing opens in Code mode to preserve its source. Merely switching modes does not rewrite source. Editing in rich mode can normalize whitespace and Markdown formatting. Custom `{{vault.group.key}}` placeholders remain literal, including keys with underscores. Unsupported Markdown dialects remain editable in Code. See [TipTap's Markdown API](https://tiptap.dev/docs/editor/markdown/getting-started/basic-usage).

## Vault

Open the padlock panel, create a vault with a master password of at least 10 characters, and add dotted keys such as `personal.username` and `personal.password`:

```markdown
**Account:** {{vault.personal.username}}
**Password:** {{vault.personal.password}}
```

In View mode, unlocked values remain masked until **Show** is clicked. **Copy** writes the value to the system clipboard; clipboard history is controlled by Windows. **Edit** updates `vault.enc` without changing the placeholder. The reference checker reports missing and unused variables using the plaintext key index even while locked.

Encryption uses frontend Web Crypto AES-256-GCM and locally bundled Argon2id WASM. Passwords use NFC-normalized UTF-8. Each vault has a random 128-bit salt; each save has a new random 96-bit nonce. Argon2id uses 64 MiB, one lane, and a calibrated 3–10 iteration count targeting about 300 ms. Cost parameters are stored in the envelope and bounded before decryption. The authenticated header includes the version, key index, salt, nonce, algorithms, and KDF parameters. Unlocking also verifies the index against the decrypted payload.

Rust only receives the encrypted envelope. Master passwords, derived keys, and decrypted values are not written to files, logs, or browser storage. Only the theme preference is stored in localStorage. The vault locks manually, when the page becomes hidden, and after five minutes of inactivity. Clearing in-memory references is best effort under JavaScript garbage collection. There is no password reset. Old Git revisions and encrypted backups continue to require their original master passwords.

## Filesystem and recovery

```text
keivbook.exe
keivbook.pdb                 # optional debugging symbols
webview2/                    # optional fixed runtime
data/                        # excluded from the application's Git repository
  .git/                      # independent data history, if enabled
  .gitignore                 # excludes .keivbook/
  .keivbook/
    setup.json
    webview/                 # local browser profile and theme preference
    backups/<original-path>/<revision>.bak
    trash/deleted-*/<original-name>
  index.md
  vault.enc
  images/
```

Ordinary file commands reject absolute paths, traversal, alternate data streams, reserved Windows names, hidden metadata, `.git`, and `vault.enc`. Symlinks and Windows reparse points/junctions are rejected. Notes and encrypted vault envelopes are limited to 8 MiB; images to 20 MiB; the Explorer to 10,000 entries and 32 folder levels. Atomic replacement and SHA-256 revision checks protect saves. Backups contain original note bytes or the encrypted vault envelope; no decrypted vault backup is made.

To recover a prior save, close KeivBook, copy the desired `.bak` from the directory matching the original relative path, and rename it to that original filename. To restore a deleted item, move it from its `trash/deleted-*` folder back into `data/`. Recovery history is retained until you remove it yourself, so it can grow over time.

The application assumes the local user and the OS are trusted. Path checks do not provide isolation from a malicious process with write access to the notebook that races filesystem operations. Do not share the data directory with untrusted writers. A strict CSP, local-only Tauri capability, sanitized rendering, inert note HTML, and narrow IPC commands reduce exposure to hostile note content. This is an application implementation with automated tests, not an independent cryptographic audit.

## Source map

- `src/main.ts`, `src/style.css`: workspace UI, editor modes, commands, and themes.
- `src/extensions.ts`: lossless vault-reference nodes and local image node views.
- `src/vault.ts`: encryption, envelope validation, and reference auditing.
- `src/markdown.ts`: sanitized rendering and relative navigation.
- `src-tauri/src/lib.rs`: scoped storage, revisions, and recovery.
- `src-tauri/src/git.rs`: scoped Git status, commit, and push.
- `src-tauri/src/main.rs`: Tauri commands and filesystem watcher.
- `tests/`: browser workflow tests; `src/*.test.ts` and Rust `#[test]` modules contain unit tests.

Tauri configuration follows the [official Tauri 2 configuration reference](https://v2.tauri.app/reference/config/). Dependency lockfiles are checked in for repeatable builds.
