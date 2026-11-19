use crate::{err, linked, Result, Store};
use git2::{Repository, RepositoryOpenFlags};
use serde::Serialize;
use std::{
    io::{ErrorKind, Write},
    path::Path,
    process::{Command, Stdio},
};

#[derive(Serialize)]
pub struct GitStatus {
    pub branch: Option<String>,
    pub can_push: bool,
    pub changes: Vec<GitChange>,
}

#[derive(Serialize)]
pub struct GitChange {
    pub path: String,
    pub index: char,
    pub worktree: char,
}

impl GitChange {
    fn staged(&self) -> bool {
        !matches!(self.index, ' ' | '?')
    }

    fn private(&self) -> bool {
        self.path
            .split('/')
            .next()
            .is_some_and(|name| name.eq_ignore_ascii_case(".keivbook"))
    }
}

impl Store {
    pub(super) fn data_repository(&self) -> Result<Option<Repository>> {
        if linked(&self.root)? {
            return Err("Data root was replaced by a link".into());
        }
        let git = self.root.join(".git");
        match git.symlink_metadata() {
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(err(e)),
            Ok(_) if linked(&git)? || !git.is_dir() => {
                return Err("Linked Git directories are not supported".into())
            }
            Ok(_) => {}
        }
        // Open only data/.git, even if the executable itself sits in a repository.
        let repo = Repository::open_ext(
            git,
            RepositoryOpenFlags::NO_SEARCH | RepositoryOpenFlags::NO_DOTGIT,
            std::iter::empty::<&Path>(),
        )
        .map_err(err)?;
        Ok(Some(repo))
    }

    pub fn git_status(&self) -> Result<GitStatus> {
        let repo = self
            .data_repository()?
            .ok_or("Configure the data repository first.")?;
        let branch = branch(&repo);
        let can_push =
            branch.is_some() && repo.head().is_ok() && repo.find_remote("origin").is_ok();
        let changes = self.git_changes()?;
        Ok(GitStatus {
            branch,
            can_push,
            changes,
        })
    }

    pub fn git_commit(&self, message: &str) -> Result<()> {
        let message = message.trim();
        if message.is_empty() {
            return Err("Enter a commit message.".into());
        }
        let _git_guard = self.git_gate.lock().map_err(err)?;
        let _guard = self.gate.lock().map_err(err)?;
        let status = self.git_status()?;
        if status.changes.is_empty() {
            return Err("No saved changes to commit.".into());
        }
        if status.changes.iter().any(GitChange::staged) {
            if status
                .changes
                .iter()
                .any(|change| change.staged() && change.index != 'D' && change.private())
            {
                return Err(
                    "Remove local .keivbook files from the Git index before committing.".into(),
                );
            }
        } else {
            // Stage the paths already reported by Git and filtered by KeivBook.
            // A NUL-delimited file keeps these paths literal and avoids command-line limits.
            let mut paths = tempfile::NamedTempFile::new().map_err(err)?;
            for change in &status.changes {
                paths.write_all(change.path.as_bytes()).map_err(err)?;
                paths.write_all(b"\0").map_err(err)?;
            }
            let paths = paths.into_temp_path();
            let pathspec_file = format!("--pathspec-from-file={}", paths.display());
            self.run_git(&[
                "--literal-pathspecs",
                "add",
                "--all",
                "--pathspec-file-nul",
                &pathspec_file,
            ])?;
        }
        self.run_git(&["commit", "-m", message])?;
        Ok(())
    }

    pub fn git_push(&self) -> Result<()> {
        let _git_guard = self.git_gate.lock().map_err(err)?;
        let repo = self
            .data_repository()?
            .ok_or("Configure the data repository first.")?;
        let branch = branch(&repo).ok_or("Switch to a branch before pushing.")?;
        repo.head().map_err(|_| "Create a commit before pushing.")?;
        repo.find_remote("origin")
            .map_err(|_| "Set an origin remote before pushing.")?;
        let refspec = format!("HEAD:refs/heads/{branch}");
        self.run_git(&[
            "push",
            "--set-upstream",
            "--no-follow-tags",
            "--",
            "origin",
            &refspec,
        ])?;
        Ok(())
    }

    fn git_changes(&self) -> Result<Vec<GitChange>> {
        let output = self.run_git(&[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
        ])?;
        Ok(output
            .split_terminator('\0')
            .filter_map(|entry| {
                let path = entry.get(3..)?.to_owned();
                let mut status = entry.chars();
                Some(GitChange {
                    path,
                    index: status.next()?,
                    worktree: status.next()?,
                })
            })
            .filter(|change| !change.private() || change.staged())
            .collect())
    }

    fn run_git(&self, args: &[&str]) -> Result<String> {
        let mut command = Command::new("git");
        command
            .current_dir(&self.root)
            .args(["--no-optional-locks", "--git-dir=.git", "--work-tree=."])
            .args(args)
            .env_remove("GIT_COMMON_DIR")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_OBJECT_DIRECTORY")
            .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let output = command.output().map_err(|e| match e.kind() {
            ErrorKind::NotFound => "Install Git and make sure git is on PATH.".into(),
            _ => err(e),
        })?;
        if !output.status.success() {
            let details = String::from_utf8_lossy(&output.stderr);
            return Err(if details.trim().is_empty() {
                let details = String::from_utf8_lossy(&output.stdout);
                if details.trim().is_empty() {
                    format!("Git failed ({})", output.status)
                } else {
                    details.trim().to_owned()
                }
            } else {
                details.trim().to_owned()
            });
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

fn branch(repo: &Repository) -> Option<String> {
    repo.find_reference("HEAD")
        .ok()?
        .symbolic_target()?
        .strip_prefix("refs/heads/")
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn commits_saved_data_and_pushes_only_the_current_branch() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("data")).unwrap();
        store.configure(true, None).unwrap();
        let repo = store.data_repository().unwrap().unwrap();
        repo.set_head("refs/heads/main").unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Notebook Test").unwrap();
        config
            .set_str("user.email", "test@example.invalid")
            .unwrap();
        config.set_bool("commit.gpgsign", false).unwrap();

        let remote_path = dir.path().join("remote.git");
        let remote = Repository::init_bare(&remote_path).unwrap();
        repo.remote("origin", remote_path.to_str().unwrap())
            .unwrap();
        let status = store.git_status().unwrap();
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert!(!status.can_push);
        assert!(status
            .changes
            .iter()
            .any(|c| c.path == "index.md" && c.index == '?'));

        store.git_commit("a1").unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.summary(), Some("a1"));
        assert!(head.tree().unwrap().get_name(".keivbook").is_none());
        assert!(store.git_status().unwrap().changes.is_empty());
        assert!(store.git_commit("a1").is_err());

        // An ignore override should still never stage KeivBook's local files.
        fs::write(store.root.join(".gitignore"), "!/.keivbook/\n").unwrap();
        fs::remove_file(store.root.join("index.md")).unwrap();
        fs::write(store.root.join("renamed note [1].md"), "renamed").unwrap();
        store.git_commit("renamed").unwrap();
        let tree = repo.head().unwrap().peel_to_tree().unwrap();
        assert!(tree.get_name(".keivbook").is_none());
        assert!(tree.get_name("index.md").is_none());
        assert!(tree.get_name("renamed note [1].md").is_some());

        fs::write(store.root.join("staged.md"), "staged").unwrap();
        fs::write(store.root.join("extra.md"), "unstaged").unwrap();
        store.run_git(&["add", "--", "staged.md"]).unwrap();
        store.git_commit("selected").unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let tree = head.tree().unwrap();
        assert!(tree.get_name("staged.md").is_some());
        assert!(tree.get_name("extra.md").is_none());
        assert!(store.git_status().unwrap().can_push);
        store.git_push().unwrap();
        assert_eq!(remote.refname_to_id("refs/heads/main").unwrap(), head.id());
        assert_eq!(config.get_string("branch.main.remote").unwrap(), "origin");
    }
}
