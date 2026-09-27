import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const MAX_CONTENT = 128 * 1024;
export type InventoryFile = { id: string; category: string; name: string; bytes: number; revision: string; modifiedAt: string; editable?: boolean };
export type CleanupRoot = { id: string; path: string; owner: string; cleanupMode?: 'inactive_owner_files' | 'stale_cache_files' };

function userLabel(root: CleanupRoot): string {
  if (root.id === 'codex_logs') return 'Codex logs';
  if (root.id === 'app_logs') return 'App logs';
  if (root.id === 'app_cache') return 'App cache';
  return root.id;
}

export function userSemantics(root: CleanupRoot) {
  return {
    user_label: userLabel(root),
    user_goal: 'release_space',
    safety: 'safe_after_preview',
    recoverability: 'not_restorable',
    action: 'cleanup',
    impact: {
      will_change: 'disk_space',
      will_not_change: ['conversations', 'projects', 'artifacts', 'credentials', 'sessions', 'memory'],
    },
  };
}


export class ResourceFiles {
protected mutation: Promise<unknown> = Promise.resolve();

protected async serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(fn, fn);
    this.mutation = result.catch(() => undefined);
    return result;
  }

protected async assertRoot(root: string) {
    const resolved = path.resolve(root);
    let current = path.parse(resolved).root;
    for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) throw Error('Symbolic resource directories are not allowed.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

protected async files(root: string, category: string, notesOnly = false): Promise<InventoryFile[]> {
    await this.assertRoot(root);
    if (!existsSync(root)) return [];
    if ((await lstat(root)).isSymbolicLink()) throw new Error('Resource root must not be a symbolic link.');
    const result: InventoryFile[] = [];
    const walk = async (directory: string, depth: number) => {
      if (depth > 6) return;
      await this.assertRoot(directory);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (result.length >= 2000) throw new Error('Inventory exceeds the supported limit; narrow the owner inventory.');
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { await walk(file, depth + 1); continue; }
        if (!entry.isFile()) continue;
        const relative = path.relative(root, file).split(path.sep).join('/');
        if (category === 'memory' && (!relative.endsWith('.md') || (notesOnly && !relative.startsWith('extensions/ad_hoc/notes/')))) continue;
        const stat = await lstat(file);
        const revision = hash(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
        result.push({ id: `${category}:${Buffer.from(relative).toString('base64url')}`, category, name: relative, bytes: stat.size, revision, modifiedAt: stat.mtime.toISOString(), ...(category === 'memory' ? { editable: relative.startsWith('extensions/ad_hoc/notes/') } : {}) });
      }
    };
    await walk(root, 0);
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

protected async resolve(id: string, category: string, root: string) {
    if (!id.startsWith(`${category}:`)) throw new Error('Resource owner does not match.');
    const relative = Buffer.from(id.slice(category.length + 1), 'base64url').toString('utf8');
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(x => x === '..' || x === '.' || !x)) throw new Error('Invalid resource reference.');
    const file = path.join(root, relative);
    await this.assertRoot(path.dirname(file));
    const canonicalRoot = await realpath(root);
    if (await realpath(file) !== path.join(canonicalRoot, relative)) throw new Error('Symbolic links are not allowed.');
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Resource is not a regular file.');
    return { file, relative, revision: hash(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`) };
  }
}
