import { assert, fs, os, path, test } from './helpers.ts';
import { spawnSync } from 'node:child_process';
import {
  packageSourceArchiveMembersStayWithinRoot,
  readPackageSourceArchiveEntries,
} from '../../../../../src/adapters/integration/agent-package-registry-parts/package-source-archive.ts';

function buildArchive(root: string, entries: Record<string, 'file' | 'directory' | 'symlink'>, archivePath: string) {
  const sourceDir = fs.mkdtempSync(path.join(root, 'source-'));
  for (const [rel, kind] of Object.entries(entries)) {
    const target = path.join(sourceDir, 'med-autocast', rel);
    if (kind === 'directory') {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (kind === 'symlink') {
      fs.symlinkSync('/etc/passwd', target);
    } else {
      fs.writeFileSync(target, 'x', 'utf8');
    }
  }
  const archived = spawnSync('tar', ['-czf', archivePath, '-C', sourceDir, 'med-autocast'], {
    encoding: 'utf8',
    // Keep the fixture deterministic across hosts: macOS tar otherwise injects
    // AppleDouble `._` members that a Linux-built package never contains.
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  assert.equal(archived.status, 0, archived.stderr);
  return sourceDir;
}

test('package source archive reader is locale-independent for non-ASCII member names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-source-archive-'));
  try {
    const archivePath = path.join(root, 'source.tar.gz');
    buildArchive(root, {
      'docs/方法适配.md': 'file',
      'skills/med-autocast/SKILL.md': 'file',
    }, archivePath);
    // A C locale is the effective default for a Finder-launched App; the reader
    // must decode UTF-8 member names from the tar headers directly instead of
    // relying on the locale-dependent `tar -t` text output.
    const entries = readPackageSourceArchiveEntries(archivePath, 'med-autocast');
    assert.equal(entries.filter((entry) => entry.kind === 'file').length, 2);
    assert.equal(entries.some((entry) => entry.path.includes('方法适配.md')), true);
    assert.equal(entries.some((entry) => entry.path.includes('\\')), false);
    assert.equal(packageSourceArchiveMembersStayWithinRoot(entries, 'med-autocast'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('package source archive reader rejects non-physical member types', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-source-archive-symlink-'));
  try {
    const archivePath = path.join(root, 'source.tar.gz');
    buildArchive(root, {
      'skills/SKILL.md': 'file',
      'skills/link': 'symlink',
    }, archivePath);
    assert.throws(
      () => readPackageSourceArchiveEntries(archivePath, 'med-autocast'),
      /non-physical member type/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('package source archive reader keeps members inside the declared root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-source-archive-escape-'));
  try {
    const archivePath = path.join(root, 'source.tar.gz');
    buildArchive(root, { 'skills/SKILL.md': 'file' }, archivePath);
    const good = readPackageSourceArchiveEntries(archivePath, 'med-autocast');
    assert.equal(packageSourceArchiveMembersStayWithinRoot(good, 'med-autocast'), true);
    assert.equal(packageSourceArchiveMembersStayWithinRoot(good, 'med-autoscience'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
