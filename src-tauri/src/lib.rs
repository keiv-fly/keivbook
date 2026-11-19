use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

pub type Result<T> = std::result::Result<T, String>;
pub const MAX_NOTE: usize = 8 * 1024 * 1024;
pub const MAX_ASSET: usize = 20 * 1024 * 1024;
pub struct Store {
    pub root: PathBuf,
    pub gate: Mutex<()>,
}
#[derive(Serialize, Clone)]
pub struct Entry {
    pub path: String,
    pub name: String,
    pub directory: bool,
    pub children: Vec<Entry>,
}
#[derive(Serialize)]
pub struct Document {
    pub content: String,
    pub revision: String,
}
#[derive(Serialize)]
pub struct Setup {
    pub repository: bool,
    pub configured: bool,
    pub remote: Option<String>,
    pub location: String,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn linked(path: &Path) -> Result<bool> {
    let m = fs::symlink_metadata(path).map_err(err)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Ok(m.file_attributes() & 0x400 != 0)
    }
    #[cfg(not(windows))]
    {
        Ok(m.file_type().is_symlink())
    }
}
pub fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn image(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"
    )
}
fn markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|x| x.to_str())
        .is_some_and(|x| x.eq_ignore_ascii_case("md"))
}

impl Store {
    pub fn new(root: PathBuf) -> Result<Self> {
        if root.exists() && linked(&root)? {
            return Err("Data directory cannot be a symlink or junction".into());
        }
        fs::create_dir_all(&root).map_err(err)?;
        let store = Self {
            root: root.canonicalize().map_err(err)?,
            gate: Mutex::new(()),
        };
        store.ensure_private_ignore()?;
        if !store.root.join("index.md").exists() {
            store.create("index.md", false)?;
            store.write("index.md", "# Welcome to KeivBook\n\nYour notes, on your computer.\n\n## Make room for ideas\n\n- Create a note from the Explorer\n- Switch between **Edit**, **View**, and **Code**\n- Press **Ctrl+S** to save\n- Keep passwords in the encrypted Vault\n\n> Ordinary Markdown. A little more organized.\n", Some(&revision(b"")), false)?;
        }
        Ok(store)
    }
    pub fn resolve(&self, rel: &str, private: bool) -> Result<PathBuf> {
        if rel.is_empty() || rel.contains('\\') || rel.contains(':') || rel.contains('\0') {
            return Err("Invalid relative path".into());
        }
        let p = Path::new(rel);
        let mut out = self.root.clone();
        if linked(&self.root)? {
            return Err("Data root was replaced by a link".into());
        }
        for part in p.components() {
            let Component::Normal(name) = part else {
                return Err("Path traversal is forbidden".into());
            };
            let s = name.to_str().ok_or("Invalid filename")?;
            let lower = s.to_ascii_lowercase();
            let stem = lower.split('.').next().unwrap_or("");
            if s.ends_with([' ', '.'])
                || s.contains(['<', '>', '"', '|', '?', '*'])
                || s.chars().any(|c| c.is_control())
                || matches!(stem, "con" | "prn" | "aux" | "nul")
                || (stem.len() == 4
                    && (stem.starts_with("com") || stem.starts_with("lpt"))
                    && stem.as_bytes()[3].is_ascii_digit())
            {
                return Err("Unsupported filename".into());
            }
            if lower == ".git" || (!private && (lower.starts_with('.') || lower == "vault.enc")) {
                return Err("Reserved path".into());
            }
            out.push(name);
            if out.symlink_metadata().is_ok() && linked(&out)? {
                return Err("Symlinks and junctions are forbidden".into());
            }
        }
        Ok(out)
    }
    pub fn tree(&self) -> Result<Vec<Entry>> {
        self.resolve("index.md", false)?;
        fn walk(root: &Path, dir: &Path, depth: usize, count: &mut usize) -> Result<Vec<Entry>> {
            if depth > 32 {
                return Err("Folder nesting exceeds 32 levels".into());
            }
            let mut entries = vec![];
            for e in fs::read_dir(dir).map_err(err)? {
                let e = e.map_err(err)?;
                let path = e.path();
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || name.eq_ignore_ascii_case("vault.enc") || linked(&path)?
                {
                    continue;
                }
                let directory = path.is_dir();
                if !directory && !markdown(&path) && !image(&path) {
                    continue;
                }
                *count += 1;
                if *count > 10000 {
                    return Err("Explorer is limited to 10,000 entries".into());
                }
                let children = if directory {
                    walk(root, &path, depth + 1, count)?
                } else {
                    vec![]
                };
                entries.push(Entry {
                    path: path
                        .strip_prefix(root)
                        .map_err(err)?
                        .to_string_lossy()
                        .replace('\\', "/"),
                    name,
                    directory,
                    children,
                });
            }
            entries.sort_by(|a, b| {
                b.directory
                    .cmp(&a.directory)
                    .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });
            Ok(entries)
        }
        walk(&self.root, &self.root, 0, &mut 0)
    }
    pub fn read(&self, rel: &str, vault: bool) -> Result<Document> {
        if vault && rel != "vault.enc" {
            return Err("Invalid vault path".into());
        }
        let p = self.resolve(rel, vault)?;
        if !vault && !markdown(&p) {
            return Err("Only Markdown files can be read as text".into());
        }
        if fs::metadata(&p).map_err(err)?.len() > MAX_NOTE as u64 {
            return Err("File exceeds 8 MiB".into());
        }
        let bytes = fs::read(p).map_err(err)?;
        Ok(Document {
            revision: revision(&bytes),
            content: String::from_utf8(bytes).map_err(err)?,
        })
    }
    pub fn write(
        &self,
        rel: &str,
        content: &str,
        expected: Option<&str>,
        vault: bool,
    ) -> Result<String> {
        let _guard = self.gate.lock().map_err(err)?;
        if content.len() > MAX_NOTE {
            return Err("File exceeds 8 MiB".into());
        }
        if vault {
            if rel != "vault.enc" {
                return Err("Invalid vault path".into());
            }
            validate_vault(content)?;
        }
        let p = self.resolve(rel, vault)?;
        if !vault && !markdown(&p) {
            return Err("Only Markdown can be saved here".into());
        }
        let old = if p.exists() {
            if fs::metadata(&p).map_err(err)?.len() > MAX_NOTE as u64 {
                return Err("Existing file exceeds 8 MiB".into());
            }
            Some(fs::read(&p).map_err(err)?)
        } else {
            None
        };
        if old.as_ref().map(|x| revision(x)).as_deref() != expected {
            return Err("CONFLICT: File changed on disk. Reload or save a copy.".into());
        }
        if let Some(bytes) = old {
            self.backup(&p, &bytes)?;
        }
        self.atomic(&p, content.as_bytes())?;
        Ok(revision(content.as_bytes()))
    }
    fn atomic(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        let mut tmp =
            tempfile::NamedTempFile::new_in(path.parent().ok_or("Missing parent")?).map_err(err)?;
        tmp.write_all(bytes).map_err(err)?;
        tmp.as_file().sync_all().map_err(err)?;
        tmp.persist(path).map_err(err)?;
        Ok(())
    }
    fn ensure_private_ignore(&self) -> Result<()> {
        let path = self.resolve(".gitignore", true)?;
        let mut content = if path.exists() {
            if fs::metadata(&path).map_err(err)?.len() > MAX_NOTE as u64 {
                return Err("Data .gitignore exceeds 8 MiB".into());
            }
            fs::read_to_string(&path).map_err(err)?
        } else {
            String::new()
        };
        if !content
            .lines()
            .any(|line| matches!(line.trim(), ".keivbook/" | "/.keivbook/"))
        {
            if !content.is_empty() && !content.ends_with('\n') {
                content.push('\n');
            }
            content.push_str("/.keivbook/\n");
            self.atomic(&path, content.as_bytes())?;
        }
        Ok(())
    }
    fn backup(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        let rel = path
            .strip_prefix(&self.root)
            .map_err(err)?
            .to_string_lossy()
            .replace('\\', "/");
        let dir = self.resolve(&format!(".keivbook/backups/{rel}"), true)?;
        fs::create_dir_all(&dir).map_err(err)?;
        let name = format!("{}.bak", revision(bytes));
        let p = self.resolve(&format!(".keivbook/backups/{rel}/{name}"), true)?;
        self.atomic(&p, bytes)
    }
    pub fn create(&self, rel: &str, directory: bool) -> Result<()> {
        let _guard = self.gate.lock().map_err(err)?;
        let p = self.resolve(rel, false)?;
        if directory {
            fs::create_dir(p).map_err(err)
        } else {
            if !markdown(&p) {
                return Err("Notes must have a .md extension".into());
            }
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(p)
                .map(|_| ())
                .map_err(err)
        }
    }
    pub fn rename(&self, old: &str, new: &str) -> Result<()> {
        let _guard = self.gate.lock().map_err(err)?;
        let from = self.resolve(old, false)?;
        let to = self.resolve(new, false)?;
        if to.exists() {
            return Err("Destination already exists".into());
        }
        if from.is_dir() {
            self.verify_subtree(&from)?;
        } else if !(markdown(&from) && markdown(&to) || image(&from) && image(&to)) {
            return Err("Unsupported file type".into());
        }
        fs::rename(from, to).map_err(err)
    }
    fn verify_subtree(&self, dir: &Path) -> Result<()> {
        for entry in fs::read_dir(dir).map_err(err)? {
            let p = entry.map_err(err)?.path();
            let rel = p
                .strip_prefix(&self.root)
                .map_err(err)?
                .to_string_lossy()
                .replace('\\', "/");
            self.resolve(&rel, false)?;
            if p.is_dir() {
                self.verify_subtree(&p)?;
            }
        }
        Ok(())
    }
    pub fn delete(&self, rel: &str) -> Result<()> {
        let _guard = self.gate.lock().map_err(err)?;
        let p = self.resolve(rel, false)?;
        if p.is_dir() {
            self.verify_subtree(&p)?;
        } else if !markdown(&p) && !image(&p) {
            return Err("Unsupported file type".into());
        }
        let dir = self.resolve(".keivbook/trash", true)?;
        fs::create_dir_all(&dir).map_err(err)?;
        let temp = tempfile::Builder::new()
            .prefix("deleted-")
            .tempdir_in(dir)
            .map_err(err)?;
        fs::rename(&p, temp.path().join(p.file_name().ok_or("Missing name")?)).map_err(err)?;
        let _ = temp.keep();
        Ok(())
    }
    pub fn asset(&self, rel: &str) -> Result<Vec<u8>> {
        let p = self.resolve(rel, false)?;
        if !image(&p) {
            return Err("Unsupported image type".into());
        }
        if fs::metadata(&p).map_err(err)?.len() > MAX_ASSET as u64 {
            return Err("Image exceeds 20 MiB".into());
        }
        fs::read(p).map_err(err)
    }
    pub fn import_image(&self, name: &str, bytes: &[u8]) -> Result<String> {
        let _guard = self.gate.lock().map_err(err)?;
        if bytes.len() > MAX_ASSET {
            return Err("Image exceeds 20 MiB".into());
        }
        let ext = Path::new(name)
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let rel = format!("images/{}.{}", revision(bytes), ext);
        let p = self.resolve(&rel, false)?;
        if !image(&p) {
            return Err("Unsupported image type".into());
        }
        fs::create_dir_all(p.parent().unwrap()).map_err(err)?;
        self.atomic(&p, bytes)?;
        Ok(rel)
    }
    pub fn setup_status(&self) -> Result<Setup> {
        let configured = self.resolve(".keivbook/setup.json", true)?.exists();
        // Check only this directory, never discover the application's parent repository.
        let repo = git2::Repository::open_ext(
            &self.root,
            git2::RepositoryOpenFlags::NO_SEARCH,
            std::iter::empty::<&Path>(),
        )
        .ok();
        let remote = repo.as_ref().and_then(|r| {
            r.find_remote("origin")
                .ok()
                .and_then(|x| x.url().map(str::to_owned))
        });
        Ok(Setup {
            repository: repo.is_some(),
            configured,
            remote,
            location: self.root.to_string_lossy().to_string(),
        })
    }
    pub fn configure(&self, initialize: bool, remote: Option<String>) -> Result<Setup> {
        let _guard = self.gate.lock().map_err(err)?;
        let url = remote.unwrap_or_default().trim().to_owned();
        if !url.is_empty()
            && (!url.starts_with("https://")
                && !url.starts_with("ssh://")
                && !url.starts_with("git@")
                || url.chars().any(|c| c.is_whitespace() || c.is_control()))
        {
            return Err("Use an HTTPS or SSH Git remote URL".into());
        }
        if initialize {
            let git_path = self.root.join(".git");
            if git_path.exists() && (linked(&git_path)? || !git_path.is_dir()) {
                return Err("Linked Git directories are not supported".into());
            }
            let repo = git2::Repository::init(&self.root).map_err(err)?;
            if !url.is_empty() {
                if repo.find_remote("origin").is_ok() {
                    repo.remote_set_url("origin", &url).map_err(err)?;
                } else {
                    repo.remote("origin", &url).map_err(err)?;
                }
            }
            self.ensure_private_ignore()?;
        }
        let config = self.resolve(".keivbook/setup.json", true)?;
        fs::create_dir_all(config.parent().unwrap()).map_err(err)?;
        self.atomic(&config, b"{\"configured\":true}")?;
        self.setup_status()
    }
}

fn validate_vault(content: &str) -> Result<()> {
    let v: serde_json::Value = serde_json::from_str(content).map_err(err)?;
    if v["version"] != 1
        || !v["keys"].is_array()
        || v["encryption"]["algorithm"] != "AES-256-GCM"
        || v["encryption"]["kdf"] != "Argon2id"
        || !v["encryption"]["ciphertext"].is_string()
    {
        return Err("Invalid encrypted vault envelope".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store() -> (tempfile::TempDir, Store) {
        let t = tempfile::tempdir().unwrap();
        let s = Store::new(t.path().join("data")).unwrap();
        (t, s)
    }
    #[test]
    fn rejects_escapes_reserved_and_windows_paths() {
        let (_t, s) = store();
        for p in [
            "../bad.md",
            "/bad.md",
            "C:/bad.md",
            "x\\bad.md",
            ".git/config",
            "vault.enc",
            "VAULT.ENC",
            "x/.git/config",
            "a.md:stream",
            "CON.md",
            "a./b.md",
            ".keivbook/a",
        ] {
            assert!(s.resolve(p, false).is_err(), "{p}");
        }
    }
    #[test]
    fn revisions_and_backups() {
        let (_t, s) = store();
        let d = s.read("index.md", false).unwrap();
        s.write("index.md", "new", Some(&d.revision), false)
            .unwrap();
        assert!(s
            .write("index.md", "stale", Some(&d.revision), false)
            .unwrap_err()
            .contains("CONFLICT"));
        assert_eq!(s.read("index.md", false).unwrap().content, "new");
        assert!(
            fs::read_dir(s.root.join(".keivbook/backups"))
                .unwrap()
                .count()
                > 0
        );
    }
    #[test]
    fn create_move_and_recover_delete() {
        let (_t, s) = store();
        s.create("notes", true).unwrap();
        s.create("notes/a.md", false).unwrap();
        assert!(s.create("notes/a.md", false).is_err());
        s.rename("notes/a.md", "notes/b.md").unwrap();
        s.delete("notes").unwrap();
        assert!(!s.root.join("notes").exists());
        assert_eq!(
            fs::read_dir(s.root.join(".keivbook/trash"))
                .unwrap()
                .count(),
            1
        );
    }
    #[test]
    fn independent_repository_and_optional_remote() {
        let (t, s) = store();
        git2::Repository::init(t.path()).unwrap();
        assert!(!s.setup_status().unwrap().repository);
        let status = s
            .configure(true, Some("https://example.com/private.git".into()))
            .unwrap();
        assert!(status.repository && status.configured);
        assert_eq!(
            status.remote.as_deref(),
            Some("https://example.com/private.git")
        );
        assert!(s.root.join(".git").is_dir());
    }
    #[test]
    fn tree_hides_private_files() {
        let (_t, s) = store();
        fs::write(s.root.join("vault.enc"), "hidden").unwrap();
        s.configure(true, None).unwrap();
        assert_eq!(s.tree().unwrap().len(), 1);
    }
    #[test]
    fn size_and_file_types() {
        let (_t, s) = store();
        assert!(s.create("bad.exe", false).is_err());
        assert!(s.asset("index.md").is_err());
        let d = s.read("index.md", false).unwrap();
        assert!(s
            .write(
                "index.md",
                &"a".repeat(MAX_NOTE + 1),
                Some(&d.revision),
                false
            )
            .is_err());
        assert!(s.write("vault.enc", "plaintext", None, true).is_err());
    }
    #[test]
    fn rejects_symlink_or_junction() {
        let (t, s) = store();
        let outside = t.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let link = s.root.join("escape");
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&outside)
                .output()
                .unwrap();
            assert!(status.status.success());
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(s.resolve("escape/test.md", false).is_err());
        assert!(!s.tree().unwrap().iter().any(|x| x.name == "escape"));
    }
}
