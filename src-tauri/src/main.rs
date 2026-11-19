#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use keivbook::{Document, Entry, Result, Setup, Store};
use notify::Watcher;
use tauri::{Emitter, Manager, State};

#[tauri::command]
fn list_tree(s: State<Store>) -> Result<Vec<Entry>> {
    s.tree()
}
#[tauri::command]
fn read_file(s: State<Store>, path: String) -> Result<Document> {
    s.read(&path, false)
}
#[tauri::command]
fn write_file(
    s: State<Store>,
    path: String,
    content: String,
    expected_revision: Option<String>,
) -> Result<String> {
    s.write(&path, &content, expected_revision.as_deref(), false)
}
#[tauri::command]
fn create_file(s: State<Store>, path: String) -> Result<()> {
    s.create(&path, false)
}
#[tauri::command]
fn create_folder(s: State<Store>, path: String) -> Result<()> {
    s.create(&path, true)
}
#[tauri::command]
fn rename_path(s: State<Store>, old_path: String, new_path: String) -> Result<()> {
    s.rename(&old_path, &new_path)
}
#[tauri::command]
fn delete_path(s: State<Store>, path: String) -> Result<()> {
    s.delete(&path)
}
#[tauri::command]
fn read_asset(s: State<Store>, path: String) -> Result<Vec<u8>> {
    s.asset(&path)
}
#[tauri::command]
fn import_image(s: State<Store>, name: String, bytes: Vec<u8>) -> Result<String> {
    s.import_image(&name, &bytes)
}
#[tauri::command]
fn read_vault(s: State<Store>) -> Result<Option<Document>> {
    if !s.resolve("vault.enc", true)?.exists() {
        Ok(None)
    } else {
        s.read("vault.enc", true).map(Some)
    }
}
#[tauri::command]
fn write_vault(
    s: State<Store>,
    encrypted_bytes: String,
    expected_revision: Option<String>,
) -> Result<String> {
    s.write(
        "vault.enc",
        &encrypted_bytes,
        expected_revision.as_deref(),
        true,
    )
}
#[tauri::command]
fn setup_status(s: State<Store>) -> Result<Setup> {
    s.setup_status()
}
#[tauri::command]
fn configure_git(s: State<Store>, initialize: bool, remote: Option<String>) -> Result<Setup> {
    s.configure(initialize, remote)
}
fn main() {
    let base = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf()
    } else {
        std::env::current_exe()
            .expect("Cannot locate executable")
            .parent()
            .unwrap()
            .to_path_buf()
    };
    let store = Store::new(base.join("data")).expect("Cannot open the portable data directory");
    let profile = store
        .resolve(".keivbook/webview", true)
        .expect("Invalid browser profile path");
    std::fs::create_dir_all(&profile).expect("Cannot create the portable browser profile");
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &profile);
    // Optional portable Fixed Version runtime. The default uses Windows 11's installed WebView2.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let runtime = parent.join("webview2");
            if runtime.join("msedgewebview2.exe").is_file() {
                std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", runtime);
            }
        }
    }
    tauri::Builder::default()
        .setup(move |app| {
            let root = store.root.clone();
            let handle = app.handle().clone();
            let mut watcher =
                notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                    if let Ok(e) = event {
                        if !matches!(e.kind, notify::EventKind::Access(_))
                            && e.paths.iter().any(|p| {
                                !p.components().any(|c| {
                                    c.as_os_str() == ".git" || c.as_os_str() == ".keivbook"
                                })
                            })
                        {
                            let _ = handle.emit("data-changed", ());
                        }
                    }
                })?;
            watcher.watch(&root, notify::RecursiveMode::Recursive)?;
            app.manage(store);
            app.manage(std::sync::Mutex::new(watcher));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_tree,
            read_file,
            write_file,
            create_file,
            create_folder,
            rename_path,
            delete_path,
            read_asset,
            import_image,
            read_vault,
            write_vault,
            setup_status,
            configure_git
        ])
        .run(tauri::generate_context!())
        .expect("KeivBook could not start");
}
