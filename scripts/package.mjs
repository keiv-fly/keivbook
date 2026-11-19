import { copyFileSync, existsSync } from "node:fs";
copyFileSync("src-tauri/target/release/keivbook.exe", "keivbook.exe");
if (existsSync("src-tauri/target/release/keivbook.pdb"))
  copyFileSync("src-tauri/target/release/keivbook.pdb", "keivbook.pdb");
console.log(
  "Portable executable: keivbook.exe (data will be created alongside it).",
);
