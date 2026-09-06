import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function isDeveloperRuntimePath(root: string) {
  let cursor = path.resolve(root);
  while (true) {
    if (fs.existsSync(path.join(cursor, '.git'))) return true;
    const parent = path.dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

export function frameworkGenerationDigest(root: string) {
  const hash = crypto.createHash('sha256');
  const visit = (relative: string) => {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      hash.update(JSON.stringify([relative, 'link', fs.readlinkSync(absolute)]));
    } else if (stat.isDirectory()) {
      hash.update(JSON.stringify([relative, 'directory', stat.mode & 0o777]));
      for (const entry of fs.readdirSync(absolute).sort()) visit(path.join(relative, entry));
    } else if (stat.isFile()) {
      hash.update(JSON.stringify([relative, 'file', stat.mode & 0o777, stat.size]));
      hash.update(fs.readFileSync(absolute));
    } else throw new Error(`Unsupported pending generation entry: ${relative}`);
  };
  visit('');
  return hash.digest('hex');
}
