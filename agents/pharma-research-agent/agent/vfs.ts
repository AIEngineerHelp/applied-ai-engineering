// The virtual file system: where sub-agents put what they find, so the
// orchestrator and the synthesis agent read files instead of carrying every
// abstract in their context. In memory during a run; saved with the run.

export interface VfsFile {
  path: string;
  content: string;
  /** Which agent wrote it. */
  by: string;
  at: number;
}

export class VirtualFS {
  private files = new Map<string, VfsFile>();

  constructor(private onWrite?: (file: VfsFile) => void) {}

  /** Paths are absolute and normalised; no "..", no empty segments. */
  static clean(path: string): string {
    const parts = path.split("/").filter((p) => p && p !== ".");
    if (parts.some((p) => p === "..")) throw new Error(`Path escapes the file system: ${path}`);
    return `/${parts.join("/")}`;
  }

  write(path: string, content: string, by: string): VfsFile {
    const file = { path: VirtualFS.clean(path), content, by, at: Date.now() };
    this.files.set(file.path, file);
    this.onWrite?.(file);
    return file;
  }

  /** Loads files saved earlier (e.g. from the database) without reporting them as new writes. */
  load(files: VfsFile[]): void {
    for (const f of files) this.files.set(VirtualFS.clean(f.path), { ...f, path: VirtualFS.clean(f.path) });
  }

  read(path: string): string {
    const file = this.files.get(VirtualFS.clean(path));
    if (!file) throw new Error(`No such file: ${path}`);
    return file.content;
  }

  exists(path: string): boolean {
    return this.files.has(VirtualFS.clean(path));
  }

  /** Files under a directory, sorted by path. */
  list(dir = "/"): VfsFile[] {
    const prefix = VirtualFS.clean(dir).replace(/\/?$/, "/");
    return [...this.files.values()].filter((f) => f.path.startsWith(prefix) || prefix === "/").sort((a, b) => a.path.localeCompare(b.path));
  }

  /** A compact listing for a prompt: path and size, one per line. */
  tree(dir = "/"): string {
    return this.list(dir)
      .map((f) => `${f.path}  (${f.content.length.toLocaleString("en-US")} chars, by ${f.by})`)
      .join("\n");
  }

  snapshot(): VfsFile[] {
    return this.list("/");
  }
}
