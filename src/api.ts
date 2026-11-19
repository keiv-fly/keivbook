import { invoke } from "@tauri-apps/api/core";
export type Entry = {
  path: string;
  name: string;
  directory: boolean;
  children: Entry[];
};
export type Document = { content: string; revision: string };
export type Setup = {
  repository: boolean;
  configured: boolean;
  remote: string | null;
  location: string;
};
export const api = {
  tree: () => invoke<Entry[]>("list_tree"),
  read: (path: string) => invoke<Document>("read_file", { path }),
  write: (path: string, content: string, expectedRevision: string | null) =>
    invoke<string>("write_file", { path, content, expectedRevision }),
  create: (path: string, folder = false) =>
    invoke<void>(folder ? "create_folder" : "create_file", { path }),
  rename: (oldPath: string, newPath: string) =>
    invoke<void>("rename_path", { oldPath, newPath }),
  delete: (path: string) => invoke<void>("delete_path", { path }),
  asset: (path: string) => invoke<number[]>("read_asset", { path }),
  importImage: (name: string, bytes: number[]) =>
    invoke<string>("import_image", { name, bytes }),
  vault: () => invoke<Document | null>("read_vault"),
  writeVault: (encryptedBytes: string, expectedRevision: string | null) =>
    invoke<string>("write_vault", { encryptedBytes, expectedRevision }),
  setup: () => invoke<Setup>("setup_status"),
  configure: (initialize: boolean, remote: string | null) =>
    invoke<Setup>("configure_git", { initialize, remote }),
};
