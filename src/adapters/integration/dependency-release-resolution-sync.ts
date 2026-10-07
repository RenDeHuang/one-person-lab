import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ResolvedDependencyRelease } from './dependency-release-resolution.ts';

/** Sync consumers delegate discovery to the same resolver CLI used by Full builds. */
export function resolveDependencyReleaseSync(dependencyId: string, options: {
  platform?: string; architecture?: string; verifyArchive?: boolean;
} = {}): ResolvedDependencyRelease {
  const script = fileURLToPath(new URL('../../../scripts/resolve-dependency-releases.mjs', import.meta.url));
  if (!fs.existsSync(script)) throw new Error('The Framework dependency resolver CLI is missing.');
  const args = [script, '--dependency', dependencyId, '--platform', options.platform ?? process.platform,
    '--arch', options.architecture ?? process.arch,
    ...(options.verifyArchive === false ? ['--metadata-only'] : [])];
  const raw = execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  const payload = JSON.parse(raw);
  const result = Array.isArray(payload.dependencies) ? payload.dependencies.find((entry: {dependency_id: string}) => entry.dependency_id === dependencyId)
    : Array.isArray(payload) ? payload.find((entry: {dependency_id: string}) => entry.dependency_id === dependencyId) : payload;
  if (!result || result.dependency_id !== dependencyId || typeof result.version !== 'string') {
    throw new Error(`Dependency resolver returned an invalid ${dependencyId} release.`);
  }
  return result;
}
