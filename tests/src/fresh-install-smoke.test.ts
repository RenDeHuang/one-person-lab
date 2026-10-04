import { registerCodexProfileTests } from './fresh-install-smoke-cases/codex-profile.ts';
import { registerInstallerAndCarrierTests } from './fresh-install-smoke-cases/installer-and-carrier.ts';
import { registerMatrixAndCleanRoomTests } from './fresh-install-smoke-cases/matrix-and-clean-room.ts';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const smokeScript = path.join(repoRoot, 'scripts', 'fresh-install-smoke.mjs');
const matrixContractPath = path.join(repoRoot, 'contracts', 'opl-framework', 'fresh-install-test-matrix.json');
const codexDefaultProfilePath = path.join(repoRoot, 'contracts', 'opl-framework', 'codex-default-profile.json');
const codexDefaultProfileExporterPath = path.join(repoRoot, 'scripts', 'export-codex-default-profile.mjs');
const installScript = path.join(repoRoot, 'install.sh');
const frameworkSourceCommit = 'a'.repeat(40);

registerInstallerAndCarrierTests({
  repoRoot,
  installScript,
  frameworkSourceCommit,
});
registerMatrixAndCleanRoomTests({
  repoRoot,
  smokeScript,
  matrixContractPath,
});
registerCodexProfileTests({
  repoRoot,
  codexDefaultProfilePath,
  codexDefaultProfileExporterPath,
});
