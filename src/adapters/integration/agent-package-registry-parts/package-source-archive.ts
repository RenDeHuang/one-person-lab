import fs from 'node:fs';
import zlib from 'node:zlib';

// Reading a gzip tar archive's member names and type flags must not depend on the
// host locale. The system `tar` CLI renders non-ASCII member names as octal
// escapes whenever the effective locale is not UTF-8 (for example a C-locale
// Finder-launched App), which makes a physical name indistinguishable from an
// injected backslash. This reader decodes the tar headers directly so member
// identity and type are byte-faithful and locale-independent.

const BLOCK_BYTES = 512;

export type PackageSourceArchiveEntry = {
  path: string;
  kind: 'file' | 'directory';
};

function decodeField(bytes: Buffer) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString('utf8');
}

function octalField(bytes: Buffer) {
  const text = bytes.toString('latin1').replace(/\0/g, '').trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function entryKind(typeFlag: string): PackageSourceArchiveEntry['kind'] | null {
  // '\0' and '0' are regular files; '5' is a directory. Everything else
  // (symlink '2', hardlink '1', char/block/fifo, PAX/GNU metadata 'x'/'g'/'L'/'K')
  // is not a physical file within the archive root and must be rejected.
  if (typeFlag === '0' || typeFlag === '\0') return 'file';
  if (typeFlag === '5') return 'directory';
  return null;
}

// Enumerates physical file/directory members of a gzip tar archive. Throws when
// the archive is malformed, uses a non-ustar layout, or contains a member type
// that is not a plain file or directory within the declared root.
export function readPackageSourceArchiveEntries(archivePath: string, archiveRoot: string): PackageSourceArchiveEntry[] {
  const compressed = fs.readFileSync(archivePath);
  let raw: Buffer;
  try {
    raw = zlib.gunzipSync(compressed);
  } catch {
    throw new Error('Package source archive is not a valid gzip stream.');
  }
  const entries: PackageSourceArchiveEntry[] = [];
  let offset = 0;
  let seenRealHeader = false;
  while (offset + BLOCK_BYTES <= raw.length) {
    const header = raw.subarray(offset, offset + BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) break;
    seenRealHeader = true;
    if (header.subarray(257, 263).toString('latin1') !== 'ustar\0') {
      throw new Error('Package source archive is not a ustar tar stream.');
    }
    const name = decodeField(header.subarray(0, 100));
    const prefix = decodeField(header.subarray(345, 500));
    const typeFlag = String.fromCharCode(header[156]);
    const size = octalField(header.subarray(124, 136));
    const dataBlocks = Math.ceil(size / BLOCK_BYTES);
    const nextOffset = offset + BLOCK_BYTES + dataBlocks * BLOCK_BYTES;
    if (nextOffset > raw.length) throw new Error('Package source archive is truncated.');
    const kind = entryKind(typeFlag);
    if (kind) {
      const memberPath = prefix ? `${prefix}/${name}` : name;
      entries.push({ path: memberPath, kind });
    } else if (typeFlag !== 'g' && typeFlag !== 'x') {
      // Metadata headers ('g'/'x') are skipped; any other type is rejected.
      throw new Error('Package source archive contains a non-physical member type.');
    }
    offset = nextOffset;
  }
  if (!seenRealHeader || entries.length === 0) {
    throw new Error('Package source archive contains no members.');
  }
  return entries;
}

export function packageSourceArchiveMembersStayWithinRoot(
  entries: PackageSourceArchiveEntry[], archiveRoot: string,
) {
  const normalizedRoot = archiveRoot.replace(/\/$/, '');
  return entries.every((entry) => {
    const normalized = entry.path.replace(/\/$/, '');
    if (normalized === normalizedRoot) return true;
    if (!normalized.startsWith(`${normalizedRoot}/`)) return false;
    // Reject absolute paths, parent-directory traversal, and backslashes that
    // would denote a Windows-style separator rather than a physical POSIX name.
    if (normalized.includes('\\')) return false;
    const segments = normalized.slice(normalizedRoot.length + 1).split('/');
    return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
  });
}
