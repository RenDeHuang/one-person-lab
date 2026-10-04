import fs from 'node:fs';
import path from 'node:path';

import { canonicalJsonText } from '../../kernel/canonical-json.ts';
import {
  foundryContentDigest,
  type ActivationTransaction,
  type AgentVersion,
} from '../../authority/evolution/index.ts';
import { packageLaunchHardStopReason } from './family-runtime-package-readiness.ts';
import { readHostedAgentRuntimeActionContracts } from './hosted-agent-runtime-binding-action-contracts.ts';
import {
  deepFreeze,
  fail,
  physicalDirectory,
  readCanonicalRecord,
  requirePackageDigest,
  requireString,
  requiredRecord,
  sha256,
  PROVENANCE_VERSION,
  type FoundryHostedAgentPackageUseBinding,
  type InstalledNativeHostedAgentRuntimeBindingProvenance,
} from './hosted-agent-runtime-binding-contract.ts';
import type { resolveStandardAgentManagedCheckout } from './standard-agent-managed-checkout.ts';

type ManagedCheckout = Awaited<ReturnType<typeof resolveStandardAgentManagedCheckout>>;

export function foundryPackageUseBinding(
  version: AgentVersion,
  candidateDirectory: string,
): FoundryHostedAgentPackageUseBinding {
  const manifestFile = path.join(candidateDirectory, 'agent/agent-pack.json');
  const manifest = readCanonicalRecord(manifestFile, 'Foundry hosted Agent Pack manifest');
  if (
    manifest.surface_kind !== 'opl_foundry_agent_pack'
    || manifest.target_agent_id !== version.target_agent_id
    || manifest.target_domain_id !== version.target_domain_id
    || manifest.blueprint_digest !== version.blueprint_digest
  ) {
    fail('Foundry hosted Agent Pack manifest identity does not match AgentVersion.', {
      version_digest: version.version_digest,
    });
  }
  const manifestSha256 = `sha256:${sha256(fs.readFileSync(manifestFile))}`;
  const closureIdentity = {
    surface_kind: 'opl_foundry_hosted_agent_package_closure',
    version: 'opl-foundry-hosted-agent-package-closure.v1',
    target_agent_id: version.target_agent_id,
    target_domain_id: version.target_domain_id,
    version_id: version.version_id,
    version_digest: version.version_digest,
    candidate_digest: version.candidate_digest,
    candidate_ref: version.candidate_ref,
    manifest_sha256: manifestSha256,
  };
  const closureDigest = `sha256:${sha256(canonicalJsonText(closureIdentity))}`;
  const versionHash = version.version_digest.slice('sha256:'.length);
  return deepFreeze({
    surface_kind: 'opl_agent_package_use_binding.v1' as const,
    binding_origin: 'foundry_active_agent_version' as const,
    use_boundary_id: `foundry-package-use:${versionHash}`,
    root_package: {
      package_id: version.target_agent_id,
      package_version: version.version_id,
      owner_language_version: null,
      package_lock_ref: `opl://foundry/agent-version/sha256/${versionHash}`,
      manifest_sha256: manifestSha256,
      content_digest: version.candidate_digest,
      source_artifact_ref: version.candidate_ref,
      artifact_digest: version.candidate_digest,
      owner_source_commit: null,
      carrier_authority: null,
    },
    provider_packages: [] as const,
    dependency_closure_digest: closureDigest,
    core_skill_tree_digest: null,
    skill_tree_digest: null,
  });
}

export function foundryPreparedRuntimeBindingRef(input: {
  transaction_kind: ActivationTransaction['transaction_kind'];
  expected_activation_revision: number;
  target_agent_id: string;
  target_domain_id: string;
  version_id: string;
  version_digest: string;
  candidate_digest: string;
  candidate_ref: string;
  catalog_target_domain_id: string;
  action_ids: readonly string[];
  package_use_binding: FoundryHostedAgentPackageUseBinding;
}) {
  const identity = {
    surface_kind: 'opl_foundry_prepared_runtime_binding' as const,
    version: 'opl-foundry-prepared-runtime-binding.v1' as const,
    transaction_kind: input.transaction_kind,
    expected_activation_revision: input.expected_activation_revision,
    target_agent_id: input.target_agent_id,
    target_domain_id: input.target_domain_id,
    version_id: input.version_id,
    version_digest: input.version_digest,
    candidate_digest: input.candidate_digest,
    candidate_ref: input.candidate_ref,
    catalog_target_domain_id: input.catalog_target_domain_id,
    action_ids: [...input.action_ids],
    package_use_binding: input.package_use_binding,
  };
  return `opl://foundry/prepared-runtime-bindings/${foundryContentDigest(identity)}`;
}

export function activationTransactionForRevision(input: {
  history: ActivationTransaction[];
  target_agent_id: string;
  target_domain_id: string;
  version_digest: string;
  revision: number;
  updated_at: string;
}) {
  const transaction = input.history.find((entry) => entry.next_revision === input.revision);
  if (
    !transaction
    || transaction.target_agent_id !== input.target_agent_id
    || transaction.target_domain_id !== input.target_domain_id
    || transaction.previous_revision !== input.revision - 1
    || transaction.to_version_digest !== input.version_digest
    || transaction.occurred_at !== input.updated_at
  ) {
    fail('Foundry serving activation history does not match the requested runtime binding.', {
      target_agent_id: input.target_agent_id,
      target_domain_id: input.target_domain_id,
      activation_revision: input.revision,
      version_digest: input.version_digest,
    });
  }
  return transaction;
}

export function durablePreparedRuntimeBindingRef(input: {
  transaction: ActivationTransaction;
  version: AgentVersion;
  recomputed_ref: string;
}) {
  const verification = input.transaction.runtime_binding_verification;
  if (
    !verification
    || verification.surface_kind !== 'opl_foundry_activation_runtime_binding_verification'
    || verification.version !== 'opl-foundry-activation-runtime-binding-verification.v1'
    || verification.verification_phase !== 'pre_commit'
    || verification.transaction_kind !== input.transaction.transaction_kind
    || verification.target_agent_id !== input.transaction.target_agent_id
    || verification.target_domain_id !== input.transaction.target_domain_id
    || verification.version_id !== input.version.version_id
    || verification.version_digest !== input.transaction.to_version_digest
    || verification.version_digest !== input.version.version_digest
    || verification.candidate_digest !== input.version.candidate_digest
    || verification.candidate_ref !== input.version.candidate_ref
    || verification.expected_activation_revision !== input.transaction.previous_revision
    || typeof verification.preflight_ref !== 'string'
    || verification.preflight_ref.length === 0
    || typeof verification.runtime_binding_ref !== 'string'
    || !verification.runtime_binding_ref.startsWith('opl://foundry/prepared-runtime-bindings/')
    || verification.runtime_binding_ref !== input.recomputed_ref
  ) {
    fail('Durable activation runtime binding verification does not match the exact serving AgentVersion.', {
      transaction_id: input.transaction.transaction_id,
      version_digest: input.version.version_digest,
    });
  }
  return verification.runtime_binding_ref;
}

export function installedNativePackageProvenance(
  managed: ManagedCheckout,
): InstalledNativeHostedAgentRuntimeBindingProvenance {
  const runtime = requiredRecord(managed.native_runtime, 'native_runtime');
  const packageStatus = requiredRecord(managed.package_status, 'package_status');
  const launchHardStop = packageLaunchHardStopReason(packageStatus);
  const pluginSourcePath = physicalDirectory(
    requireString(runtime.plugin_source_path, 'native_runtime.plugin_source_path'),
    'Installed native carrier source root',
  );
  const acceptedTargetDomainIds = [
    managed.agent.target_domain_id,
    managed.agent.domain_id,
    managed.agent.agent_id,
    ...managed.agent.aliases,
  ];
  const { catalog, registry } = readHostedAgentRuntimeActionContracts(
    pluginSourcePath,
    acceptedTargetDomainIds,
  );
  const actionContractsSha256 = `sha256:${sha256(canonicalJsonText({
    action_catalog: catalog,
    handler_registry: registry,
  }))}`;
  const pluginSelector = requireString(runtime.plugin_selector, 'native_runtime.plugin_selector');
  if (
    managed.runtime_source_kind !== 'installed_native_carrier'
    || managed.package_id !== managed.agent.agent_id
    || launchHardStop !== null
    || managed.package_use_binding !== null
    || managed.use_boundary_id !== null
    || pluginSourcePath !== managed.checkout_root
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pluginSelector)
  ) {
    fail('Installed descriptor and native carrier must resolve as one launchable hosted runtime.', {
      package_id: managed.package_id,
      agent_id: managed.agent.agent_id,
      launch_blocked_reason: launchHardStop,
      plugin_source_path: pluginSourcePath,
      checkout_root: managed.checkout_root,
    });
  }
  return {
    surface_kind: 'opl_hosted_agent_runtime_binding_provenance',
    version: PROVENANCE_VERSION,
    source_kind: 'installed_native_carrier',
    target_agent_id: managed.agent.agent_id,
    target_domain_id: managed.agent.target_domain_id,
    package_id: managed.package_id,
    package_version: requireString(runtime.package_version, 'native_runtime.package_version'),
    carrier_installed_version: requireString(
      runtime.carrier_installed_version,
      'native_runtime.carrier_installed_version',
    ),
    owner_manifest_sha256: requirePackageDigest(
      runtime.manifest_sha256,
      'native_runtime.manifest_sha256',
    ),
    plugin_selector: pluginSelector,
    marketplace_source: requireString(runtime.marketplace_source, 'native_runtime.marketplace_source'),
    plugin_source_path: pluginSourcePath,
    source_tree_sha256: requirePackageDigest(
      runtime.source_tree_sha256,
      'native_runtime.source_tree_sha256',
    ),
    action_contracts_sha256: actionContractsSha256,
  };
}

export function installedNativeProvenance(managed: ManagedCheckout): InstalledNativeHostedAgentRuntimeBindingProvenance {
  if ((managed as any).runtime_source_kind !== 'installed_native_carrier') {
    fail('Hosted Standard Agent actions require installed native carrier runtime provenance.');
  }
  return installedNativePackageProvenance(managed);
}
