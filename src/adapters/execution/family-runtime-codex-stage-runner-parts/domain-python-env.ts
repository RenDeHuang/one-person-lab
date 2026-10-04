import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { stringValue as optionalString } from '../../../kernel/json-record.ts';
import { isRecord, type JsonRecord } from './shared.ts';

/**
 * A MAS-hosted Stage Attempt calls its own Python domain handlers (for example
 * `med_autoscience.authority_handlers._generation_manifest.build_stage_review_input_snapshot_bundle`)
 * inside the Codex executor process. Those handlers import both the domain pack's
 * own `src/` package and the framework's `python/opl_framework` authority package,
 * and the framework package needs Python >= 3.10 (the pack itself declares 3.12).
 *
 * A bare Codex stage attempt previously inherited the worker's PATH, where `python3`
 * resolves to the system 3.9 interpreter, and no PYTHONPATH was injected. That made
 * the import impossible, so producers/repairers could never materialize the exact
 * review-input snapshot request and the quality gate dead-looped across stages.
 *
 * This mirrors the existing `pack-native-helper-execution.ts` convention — pack
 * source root and framework python root on PYTHONPATH — and additionally guarantees
 * a Python interpreter new enough for those imports is first on PATH.
 */

const FRAMEWORK_PYTHON_ROOT = path.resolve(import.meta.dirname, '../../../../python');
const MIN_PYTHON = { major: 3, minor: 11 } as const;

function atLeastMinimum(major: number, minor: number) {
  return major > MIN_PYTHON.major || (major === MIN_PYTHON.major && minor >= MIN_PYTHON.minor);
}

function parseVersionFromPath(candidate: string): { major: number; minor: number } | null {
  const match = /(?:^|[^0-9])python(\d+)\.(\d+)(?:[^0-9]|$)/.exec(candidate)
    ?? /cpython-(\d+)\.(\d+)/.exec(candidate);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return Number.isFinite(major) && Number.isFinite(minor) ? { major, minor } : null;
}

function isExecutableFile(candidate: string) {
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function dirnameOfPythonCommand(command: string) {
  const resolved = command.includes(path.sep) ? command : null;
  return resolved ? path.dirname(resolved) : null;
}

function uvManagedPythonBins(env: NodeJS.ProcessEnv) {
  const installDir = optionalString(env.UV_PYTHON_INSTALL_DIR)
    ?? path.join(optionalString(env.HOME) ?? os.homedir(), '.local', 'share', 'uv', 'python');
  const found: Array<{ dir: string; version: { major: number; minor: number } }> = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(installDir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const binDir = path.join(installDir, entry, 'bin');
    if (!isExecutableFile(path.join(binDir, 'python3'))) continue;
    const version = parseVersionFromPath(entry);
    if (!version) continue;
    found.push({ dir: binDir, version });
  }
  return found.sort((left, right) => (
    right.version.major - left.version.major || right.version.minor - left.version.minor
  ));
}

function resolvePythonBinDir(env: NodeJS.ProcessEnv): string | null {
  const managed = optionalString(env.OPL_MANAGED_PYTHON);
  if (managed) {
    const dir = dirnameOfPythonCommand(managed) ?? (isExecutableFile(managed) ? path.dirname(managed) : null);
    if (dir) return dir;
  }
  const explicit = optionalString(env.OPL_DOMAIN_PYTHON_COMMAND);
  if (explicit) {
    const dir = dirnameOfPythonCommand(explicit);
    if (dir) return dir;
  }
  for (const candidate of uvManagedPythonBins(env)) {
    if (atLeastMinimum(candidate.version.major, candidate.version.minor)) return candidate.dir;
  }
  return null;
}

function domainPackSourceRoot(attempt: JsonRecord) {
  const locator = isRecord(attempt.workspace_locator) ? attempt.workspace_locator : {};
  const packRoot = optionalString(locator.domain_pack_root) ?? optionalString(attempt.domain_pack_root);
  if (!packRoot) return null;
  const srcRoot = path.join(packRoot, 'src');
  try {
    return fs.statSync(srcRoot).isDirectory() ? srcRoot : null;
  } catch {
    return null;
  }
}

export function domainPythonEnvironment(input: {
  attempt: JsonRecord;
  env?: NodeJS.ProcessEnv;
}): Record<string, string | undefined> {
  const env = { ...process.env, ...(input.env ?? {}) };
  const pythonPathEntries = [
    domainPackSourceRoot(input.attempt),
    fs.existsSync(path.join(FRAMEWORK_PYTHON_ROOT, 'opl_framework')) ? FRAMEWORK_PYTHON_ROOT : null,
    optionalString(env.PYTHONPATH),
  ].filter((entry): entry is string => Boolean(entry));
  const overlay: Record<string, string | undefined> = {
    PYTHONPATH: pythonPathEntries.join(path.delimiter),
    PYTHONDONTWRITEBYTECODE: env.PYTHONDONTWRITEBYTECODE ?? '1',
  };
  const pythonBinDir = resolvePythonBinDir(env);
  if (pythonBinDir) {
    const currentPath = optionalString(env.PATH) ?? '';
    const segments = currentPath.split(path.delimiter).filter(Boolean);
    if (segments[0] !== pythonBinDir) {
      overlay.PATH = [pythonBinDir, ...segments.filter((segment) => segment !== pythonBinDir)]
        .join(path.delimiter);
    }
  }
  return overlay;
}

export const __testing = {
  FRAMEWORK_PYTHON_ROOT,
  domainPackSourceRoot,
  resolvePythonBinDir,
  uvManagedPythonBins,
};
