import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertDeepEqualJson } from '../assertions.ts';
  validateExposureClasses(policy);
  validateInstallerSurfaces(policy);
  validateFirstRunUserPresentation(policy.first_run_user_presentation);
  validateSetupFlowContract(policy.setup_flow_contract);

  validateInstallExposureRuntimeAndDistribution(policy);
}
export { validateComponentInteroperability };

