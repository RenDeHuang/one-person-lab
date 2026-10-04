import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  binPath,
  createFakeCodexFixture,
  createFakeFamilySkillWorkspace,
  runEntryPathRaw,
} from '../cli-codex-default-shell-helpers.ts';

test('installed opl launcher does not run legacy family skill migration before raw Codex entry', () => {
  const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-launcher-skill-sync-'));
  const homeDir = path.join(captureDir, 'home');
  const { workspaceRoot, syncLogPath } = createFakeFamilySkillWorkspace(captureDir);
  const { fixtureRoot, codexPath } = createFakeCodexFixture(`
echo "CODEX ENTRY"
exit 0
`);
  fs.mkdirSync(homeDir, { recursive: true });

  try {
    const result = runEntryPathRaw(binPath, [], {
      HOME: homeDir,
      OPL_CODEX_BIN: codexPath,
      OPL_FAMILY_WORKSPACE_ROOT: workspaceRoot,
    });

    assert.equal(result.stdout, 'CODEX ENTRY\n');
    assert.equal(fs.existsSync(syncLogPath), false);
    assert.equal(fs.existsSync(path.join(homeDir, '.codex', 'config.toml')), false);
    assert.equal(fs.existsSync(path.join(homeDir, '.codex', 'plugins')), false);
    assert.equal(
      fs.existsSync(path.join(homeDir, 'Library', 'Application Support', 'OPL', 'state', 'codex-plugin-carriers')),
      false,
    );
  } finally {
    fs.rmSync(captureDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
