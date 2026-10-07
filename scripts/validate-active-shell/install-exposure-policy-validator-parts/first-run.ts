import { assertDeepEqualJson, assertIncludesAll, readJson } from '../assertions.ts';
import { assertFirstRunProgressModelShape, assertNonEmptyStringArray } from '../shared-contract-validators.ts';
import { productProfilePath } from '../validation-config.ts';
import {
  validateFirstRunUserPresentation,
  validateSetupFlowContract,
} from './install-exposure-policy-validator-parts/first-run.ts';

export {
  componentInteroperabilityRef,
  componentCompatibilityRequirementsSha256,
  validateComponentCompatibilityReceipt,
} from './install-exposure-policy-validator-parts/compatibility.ts';

export function validateInstallExposurePolicy(policy) {
  validateInstallExposureHeader(policy);
  validateComponentInteroperability(policy.component_interoperability);
  validateCapabilityGovernance(policy.capability_governance);
  validateCanonicalMetadataSources(policy.canonical_metadata_sources);
export {
  expectedFirstRunProgressModel,
  validateFirstRunUserPresentation,
  validateSetupFlowContract,
};

