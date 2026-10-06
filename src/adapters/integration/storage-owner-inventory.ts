import fs from 'node:fs';
import path from 'node:path';

import {
  agentPackageStorageNavigationAction,
  webuiHostActionRequired,
  writeStorageOwnerInventoryProjection,
  type StorageOwnerProjection,
} from './storage-owner-inventory-snapshot.ts';

export const STORAGE_SCAN_DEFAULT_MAX_ENTRIES = 20_000;
export const STORAGE_SCAN_DEFAULT_DEADLINE_MS = 750;

export type StorageScanReason =
  | 'path_not_absolute'
  | 'path_unsafe'
  | 'path_missing'
  | 'path_not_directory'
  | 'path_symlink'
  | 'permission_denied'
  | 'path_changed_during_scan'
  | 'deadline_exceeded'
  | 'entry_limit_exceeded'
  | 'scan_error'
  | null;

export type StoragePathUsage = {
  complete: boolean;
  reason_code: StorageScanReason;
  bytes: number | null;
  entry_count: number;
  excluded_root_count: number;
};

function unknownUsage(reasonCode: Exclude<StorageScanReason, null>, entryCount = 0): StoragePathUsage {
  return {
    complete: false,
    reason_code: reasonCode,
    bytes: null,
    entry_count: entryCount,
    excluded_root_count: 0,
  };
}

function isSameOrInside(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function scanFailureReason(error: unknown, rootWasVisible: boolean): Exclude<StorageScanReason, null> {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission_denied';
  if (code === 'ENOENT') return rootWasVisible ? 'path_changed_during_scan' : 'path_missing';
  return 'scan_error';
}

export function scanStoragePath(
  candidate: string,
  options: {
    root?: string;
    excludedRoots?: string[];
    maxEntries?: number;
    deadlineMs?: number;
    now?: () => number;
  } = {},
): StoragePathUsage {
  if (!path.isAbsolute(candidate)) return unknownUsage('path_not_absolute');
  const resolved = path.resolve(candidate);
  const root = path.resolve(options.root ?? candidate);
  if (resolved === path.parse(resolved).root || !isSameOrInside(root, resolved)) {
    return unknownUsage('path_unsafe');
  }
  const excludedRoots = (options.excludedRoots ?? [])
    .filter((entry) => path.isAbsolute(entry))
    .map((entry) => path.resolve(entry));
  if (excludedRoots.some((excluded) => isSameOrInside(excluded, resolved))) {
    return unknownUsage('path_unsafe');
  }

  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(resolved);
  } catch (error) {
    return unknownUsage(scanFailureReason(error, false));
  }
  if (rootStat.isSymbolicLink()) return unknownUsage('path_symlink');
  if (!rootStat.isDirectory()) return unknownUsage('path_not_directory');

  const maxEntries = Math.max(0, Math.trunc(options.maxEntries ?? STORAGE_SCAN_DEFAULT_MAX_ENTRIES));
  if (maxEntries === 0) return unknownUsage('entry_limit_exceeded');
  const now = options.now ?? Date.now;
  const deadline = now() + Math.max(0, options.deadlineMs ?? STORAGE_SCAN_DEFAULT_DEADLINE_MS);
  const stack = [resolved];
  let bytes = 0;
  let entryCount = 0;
  let excludedRootCount = 0;

  while (stack.length > 0) {
    if (now() >= deadline) return unknownUsage('deadline_exceeded', entryCount);
    if (entryCount >= maxEntries) return unknownUsage('entry_limit_exceeded', entryCount);
    const current = stack.pop()!;
    if (excludedRoots.some((excluded) => isSameOrInside(excluded, current))) {
      excludedRootCount += 1;
      continue;
    }
    try {
      const stat = fs.lstatSync(current);
      entryCount += 1;
      bytes += stat.size;
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      const directory = fs.opendirSync(current);
      try {
        while (true) {
          if (now() >= deadline) return unknownUsage('deadline_exceeded', entryCount);
          if (entryCount + stack.length >= maxEntries) {
            return unknownUsage('entry_limit_exceeded', entryCount);
          }
          const entry = directory.readSync();
          if (!entry) break;
          const child = path.join(current, entry.name);
          if (excludedRoots.some((excluded) => isSameOrInside(excluded, child))) {
            entryCount += 1;
            excludedRootCount += 1;
            continue;
          }
          stack.push(child);
        }
      } finally {
        directory.closeSync();
      }
    } catch (error) {
      return unknownUsage(scanFailureReason(error, true), entryCount);
    }
  }

  return {
    complete: true,
    reason_code: null,
    bytes,
    entry_count: entryCount,
    excluded_root_count: excludedRootCount,
  };
}

function persistStorageProjection(
  section: 'agent_package_store' | 'webui_data_volume',
  projection: StorageOwnerProjection,
  persist: boolean,
) {
  if (!persist) return projection;
  try {
    writeStorageOwnerInventoryProjection(section, projection);
    return projection;
  } catch {
    return {
      ...projection,
      status: 'attention_required' as const,
      reason_code: 'inventory_cache_write_failed',
    } satisfies StorageOwnerProjection;
  }
}

export function buildAgentPackageStoreStorageInventory(input: {
  /** Compatibility-only inputs; native carriers own Package byte accounting. */
  lockIndex?: unknown;
  installedPackageIds?: ReadonlySet<string>;
  installedDescriptors?: ReadonlyMap<string, unknown>;
  now?: Date;
  persist?: boolean;
  scan?: typeof scanStoragePath;
  clock?: () => number;
  maxEntries?: number;
  deadlineMs?: number;
} = {}) {
  const now = input.now ?? new Date();
  const projection: StorageOwnerProjection = {
    status: 'attention_required',
    observed_at: now.toISOString(),
    stale: false,
    bytes: null,
    reclaimable_bytes: null,
    owner_route: '/settings/agents',
    projected_action: agentPackageStorageNavigationAction(),
    reason_code: 'carrier_owned_storage_unmeasured',
  };
  return persistStorageProjection('agent_package_store', projection, input.persist !== false);
}

function configuredWebuiDataDir(explicit?: string | null) {
  const value = explicit?.trim()
    || process.env.OPL_DATA_DIR?.trim()
    || null;
  if (!value) return { data_dir: null, reason_code: 'webui_data_root_not_configured' } as const;
  if (!path.isAbsolute(value)) {
    return { data_dir: null, reason_code: 'named_volume_not_directly_observable' } as const;
  }
  return { data_dir: path.resolve(value), reason_code: null } as const;
}

export function buildWebuiDataVolumeStorageInventory(input: {
  dataDir?: string | null;
  projectsDir?: string | null;
  now?: Date;
  persist?: boolean;
  scan?: typeof scanStoragePath;
  clock?: () => number;
  maxEntries?: number;
  deadlineMs?: number;
} = {}) {
  const clock = input.clock ?? Date.now;
  const now = input.now ?? new Date();
  const configured = configuredWebuiDataDir(input.dataDir);
  if (!configured.data_dir) {
    const projection: StorageOwnerProjection = {
      status: configured.reason_code === 'webui_data_root_not_configured' ? 'not_configured' : 'unavailable',
      observed_at: now.toISOString(),
      stale: false,
      bytes: null,
      reclaimable_bytes: null,
      owner_route: '/settings/storage#webui-data',
      projected_action: webuiHostActionRequired(),
      reason_code: configured.reason_code,
    };
    return persistStorageProjection('webui_data_volume', projection, input.persist !== false);
  }

  const excludedRoots = [path.join(configured.data_dir, 'projects')];
  const explicitProjectsDir = input.projectsDir?.trim() || process.env.OPL_PROJECTS_DIR?.trim() || null;
  if (explicitProjectsDir && path.isAbsolute(explicitProjectsDir)
    && isSameOrInside(configured.data_dir, explicitProjectsDir)) {
    excludedRoots.push(path.resolve(explicitProjectsDir));
  }
  const usage = (input.scan ?? scanStoragePath)(configured.data_dir, {
    root: configured.data_dir,
    excludedRoots: [...new Set(excludedRoots)],
    maxEntries: input.maxEntries ?? STORAGE_SCAN_DEFAULT_MAX_ENTRIES,
    deadlineMs: input.deadlineMs ?? STORAGE_SCAN_DEFAULT_DEADLINE_MS,
    now: clock,
  });
  const unavailableReasons = new Set<StorageScanReason>([
    'path_not_absolute',
    'path_unsafe',
    'path_missing',
    'path_not_directory',
    'path_symlink',
    'permission_denied',
  ]);
  const projection: StorageOwnerProjection = {
    status: usage.complete
      ? 'available'
      : unavailableReasons.has(usage.reason_code) ? 'unavailable' : 'attention_required',
    observed_at: now.toISOString(),
    stale: false,
    bytes: usage.bytes,
    reclaimable_bytes: null,
    owner_route: '/settings/storage#webui-data',
    projected_action: webuiHostActionRequired(),
    reason_code: usage.reason_code,
  };
  return persistStorageProjection('webui_data_volume', projection, input.persist !== false);
}
