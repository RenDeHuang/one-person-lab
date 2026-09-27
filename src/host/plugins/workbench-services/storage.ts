import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ResourceFiles, hash, MAX_CONTENT, userSemantics, type CleanupRoot, type InventoryFile } from './resource-files.ts';
export class WorkbenchStorage extends ResourceFiles {
readonly cleanupRoots: CleanupRoot[];
readonly inventoryRoots: CleanupRoot[];
readonly receiptRoot: string | null;
constructor(cleanupRoots: CleanupRoot[], inventoryRoots: CleanupRoot[] = [], receiptRoot: string | null = null) { super(); this.cleanupRoots = cleanupRoots; this.inventoryRoots = inventoryRoots; this.receiptRoot = receiptRoot; }
private previews = new Map<string, { expires: number; files: InventoryFile[] }>();

private async summarize(root: CleanupRoot) {
    let bytes = 0; let count = 0; let truncated = false;
    const walk = async (directory: string, depth: number) => {
      if (depth > 6 || count >= 6000) { truncated = true; return; }
      await this.assertRoot(directory);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (count >= 6000) { truncated = true; break; }
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), depth + 1);
        else if (entry.isFile()) { const stat = await lstat(path.join(directory, entry.name)); if (!stat.isSymbolicLink()) { bytes += stat.size; count++; } }
      }
    };
    try {
      if (!existsSync(root.path)) return { id: root.id, owner: root.owner, status: 'not_configured', bytes: null, cleanupAllowed: false };
      await walk(root.path, 0);
      return { id: root.id, owner: root.owner, status: truncated ? 'partial' : 'available', bytes, fileCount: count, cleanupAllowed: false, truncated };
    } catch { return { id: root.id, owner: root.owner, status: 'read_error', bytes: null, cleanupAllowed: false }; }
  }

async inventory() {
    const startedAt = Date.now();
    const categories = await Promise.all(this.cleanupRoots.map(async root => {
      const files = await this.files(root.path, root.id);
      // Active files are kept. Only owner-declared logs/cache roots are admitted.
      const reclaimable = files.filter(file => Date.parse(file.modifiedAt) < Date.now() - 86400000);
      const bytes = files.reduce((n, f) => n + f.bytes, 0);
      const reclaimableBytes = reclaimable.reduce((n, f) => n + f.bytes, 0);
      return {
        id: root.id,
        owner: root.owner,
        bytes,
        reclaimableBytes,
        retainedBytes: bytes - reclaimableBytes,
        expectedAfterBytes: bytes - reclaimableBytes,
        cleanupBoundary: 'owner_declared_root',
        cleanupMode: root.cleanupMode ?? 'inactive_owner_files',
        ...userSemantics(root),
        files: reclaimable,
      };
    }));
    const observedAt = new Date().toISOString();
    const protectedCategories = await Promise.all(this.inventoryRoots.map(root => this.summarize(root)));
    const totalBytes = [...categories, ...protectedCategories].reduce((total, category) => total + (category.bytes ?? 0), 0);
    const reclaimableBytes = categories.reduce((total, category) => total + category.reclaimableBytes, 0);
    return {
      schema: 'opl_local_data_lifecycle_inventory.v1',
      status: 'available',
      observed_at: observedAt,
      scan_duration_ms: Math.max(0, Date.now() - startedAt),
      stale: false,
      totalBytes,
      total_bytes: totalBytes,
      reclaimableBytes,
      reclaimable_bytes: reclaimableBytes,
      user_summary: {
        user_goal: 'release_space',
        current_state: 'inventoried',
        next_action: reclaimableBytes > 0 ? 'preview_cleanup' : 'none',
        expected_after_bytes: totalBytes - reclaimableBytes,
        recoverability: 'not_restorable',
      },
      categories,
      protectedCategories,
      exclusions: ['workspace', 'artifacts', 'credentials', 'sessions', 'memory', 'active_files', 'symbolic_links'],
      restoreSupported: false,
    };
  }

async cleanupPreview(ids: string[]) {
    if (!Array.isArray(ids) || ids.length > 2000 || !ids.length) throw new Error('Select files from the owner inventory.');
    const inventory = await this.inventory();
    const eligible = new Map(inventory.categories.flatMap(c => c.files).map(f => [f.id, f]));
    const files = [...new Set(ids)].map(id => { const file = eligible.get(id); if (!file) throw new Error('Selected file is no longer reclaimable.'); return file; });
    for (const [key, value] of this.previews) if (value.expires < Date.now()) this.previews.delete(key);
    if (this.previews.size > 100) throw new Error('Too many pending previews.');
    const token = randomUUID();
    this.previews.set(token, { files, expires: Date.now() + 300000 });
    const selectedBytes = files.reduce((n, f) => n + f.bytes, 0);
    const categoryTotals = new Map(inventory.categories.map(category => [category.id, category]));
    const selectedByCategory = new Map<string, number>();
    for (const file of files) selectedByCategory.set(file.category, (selectedByCategory.get(file.category) ?? 0) + file.bytes);
    const retainedBytes = [...selectedByCategory].reduce((total, [category, selected]) => total + Math.max(0, (categoryTotals.get(category)?.bytes ?? 0) - selected), 0);
    const planId = randomUUID();
    const planHash = hash(JSON.stringify({ planId, files, selectedBytes, retainedBytes, observedAt: inventory.observed_at }));
    return {
      status: 'preview',
      token,
      plan_id: planId,
      plan_hash: planHash,
      files,
      owner: 'Codex / App log and cache owners',
      affected_categories: [...new Set(files.map(f => f.category))],
      summary: `${files.length} files, ${selectedBytes} bytes; only inactive owner-declared logs and caches.`,
      next_visible_step: 'Confirm within 5 minutes. Changed files require a new preview.',
      user_goal: 'release_space',
      current_state: { selected_bytes: selectedBytes, retained_bytes: retainedBytes, inventory_observed_at: inventory.observed_at },
      expected_state: { released_bytes: selectedBytes, retained_bytes: inventory.total_bytes - selectedBytes, inventory_observed_after: 'required' },
      impact: { will_change: 'disk_space', will_not_change: ['conversations', 'projects', 'artifacts', 'credentials', 'sessions', 'memory'] },
      recoverability: 'not_restorable',
      bytes: selectedBytes,
      selected_bytes: selectedBytes,
      retained_bytes: retainedBytes,
      observed_at: inventory.observed_at,
      restore_supported: false,
      receipt_ref: null,
      expiresInSeconds: 300,
    };
  }

async cleanupExecute(token: string, confirmed: boolean) {
    return this.serialized(() => this.executeCleanup(token, confirmed));
  }

private async executeCleanup(token: string, confirmed: boolean) {
    const preview = this.previews.get(token);
    if (!confirmed || !preview || preview.expires < Date.now()) throw new Error('A current preview and explicit confirmation are required.');
    this.previews.delete(token);
    const targets = await Promise.all(preview.files.map(async file => {
      const root = this.cleanupRoots.find(r => r.id === file.category);
      if (!root) throw new Error('Unknown data owner.');
      const target = await this.resolve(file.id, root.id, root.path);
      if (target.revision !== file.revision) throw new Error('Inventory changed; preview again before cleaning.');
      return { file, root, target };
    }));
    const removed: string[] = [];
    for (const { file, root, target } of targets) {
      try {
        if ((await this.resolve(file.id, root.id, root.path)).revision !== file.revision) throw new Error('Inventory changed.');
        await unlink(target.file); removed.push(file.id);
      } catch { return { status: 'partial', removed, summary: `${removed.length} files removed before an error. Inspect the remaining inventory and preview again.`, reason: 'Inventory changed or a file could not be removed; inspect and preview again.' }; }
    }
    const receiptRef = `workbench-cleanup:${randomUUID()}`;
    const receipt = { schema: 'opl_workbench_cleanup_receipt.v1', receipt_ref: receiptRef, removed, removed_count: removed.length, created_at: new Date().toISOString(), restore_supported: false, owner: 'declared_log_cache_owners' };
    if (this.receiptRoot) {
      await mkdir(this.receiptRoot, { recursive: true, mode: 0o700 });
      await writeFile(path.join(this.receiptRoot, `${receiptRef.slice(receiptRef.lastIndexOf(':') + 1)}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
    let afterInventory: Awaited<ReturnType<WorkbenchStorage['inventory']>> | null = null;
    try { afterInventory = await this.inventory(); } catch { afterInventory = null; }
    return {
      status: 'executed',
      removed,
      summary: `${removed.length} inactive owner-declared log/cache files removed. Protected data was retained.`,
      owner: 'declared_log_cache_owners',
      receipt_ref: receiptRef,
      restore_supported: false,
      user_goal: 'release_space',
      expected_state: { released_files: removed.length, readback: afterInventory ? 'confirmed' : 'unavailable' },
      terminal_readback: {
        removed_count: removed.length,
        receipt_ref: receiptRef,
        inventory_status: afterInventory ? 'confirmed' : 'unavailable',
        inventory: afterInventory ? {
          observed_at: afterInventory.observed_at,
          total_bytes: afterInventory.total_bytes,
          reclaimable_bytes: afterInventory.reclaimable_bytes,
        } : null,
      },
    };
  }
}
