import fs from 'node:fs';
import path from 'node:path';

import { isRecord } from './contract-validation.ts';
import { parseJsonText } from './json-file.ts';
import { sameMarketplaceSource } from './marketplace-source-identity.ts';

function pathWithin(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export function runtimeRootContainsDescriptor(root: string, descriptorRef: string) {
  const descriptorPath = path.resolve(root, descriptorRef);
  if (!pathWithin(root, descriptorPath)) return false;
  try {
    const stat = fs.lstatSync(descriptorPath);
    return stat.isFile()
      && !stat.isSymbolicLink()
      && pathWithin(root, fs.realpathSync.native(descriptorPath));
  } catch {
    return false;
  }
}

export function gitMarketplaceRuntimeRoot(
  pluginSourcePath: string,
  marketplaceSource: string,
  descriptorRef: string,
) {
  let candidate = path.dirname(pluginSourcePath);
  while (candidate !== path.dirname(candidate)) {
    const markerPath = path.join(candidate, '.codex-marketplace-install.json');
    try {
      const stat = fs.lstatSync(markerPath);
      const marker = parseJsonText(fs.readFileSync(markerPath, 'utf8'));
      if (!stat.isFile() || stat.isSymbolicLink() || !isRecord(marker)) return null;
      const source = typeof marker.source === 'string' ? marker.source.trim() : '';
      return source
        && sameMarketplaceSource(source, marketplaceSource)
        && runtimeRootContainsDescriptor(candidate, descriptorRef)
        ? candidate
        : null;
    } catch {
      candidate = path.dirname(candidate);
    }
  }
  return null;
}
