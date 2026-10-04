import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { FrameworkContractError, isRecord } from '../../../../kernel/contract-validation.ts';
import { assertJsonSchemaPayload } from '../../../../kernel/schema-registry.ts';
import {
  normalizeFlowCapabilityBundles,
} from '../flow-capability-compiler.ts';
import type {
  AgentPackageFlowCapabilityBundle,
  AgentPackageManagedPolicyDependency,
} from '../types.ts';
import {
  MIGRATION_SURFACE_KINDS,
  type ManagedPolicyIdentity,
  type MigrationSurfaceKind,
  type MigrationGroup,
  type OplFlowPolicy,
} from './types.ts';

function normalizeCodexModelPolicy(
  value: Record<string, unknown>,
): OplFlowPolicy['codex_model_policy'] {
  const configuredDefault = isRecord(value.configured_default)
    ? value.configured_default
    : null;
  const model = configuredDefault && typeof configuredDefault.model === 'string'
    ? configuredDefault.model.trim()
    : '';
  const reasoningEffort = configuredDefault && typeof configuredDefault.reasoning_effort === 'string'
    ? configuredDefault.reasoning_effort.trim()
    : '';
  const overridePrecedence = stringArray(
    value.override_precedence,
    'codex_model_policy.override_precedence',
  );
  if (
    value.authority !== 'opl-flow'
    || value.mode_default !== 'auto'
    || !model
    || !reasoningEffort
    || overridePrecedence.length === 0
    || new Set(overridePrecedence).size !== overridePrecedence.length
    || !isRecord(value.catalog_policy)
  ) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Managed policy Codex model recommendation is invalid.',
      { failure_code: 'agent_package_managed_policy_model_projection_invalid' },
    );
  }
  return {
    authority: 'opl-flow',
    mode_default: 'auto',
    configured_default: {
      model,
      reasoning_effort: reasoningEffort,
    },
    override_precedence: overridePrecedence,
    catalog_policy: structuredClone(value.catalog_policy),
  };
}

function sha256File(filePath: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resolveInside(root: string, relativePath: string, field: string) {
  const resolvedRoot = fs.realpathSync(root);
  const candidate = path.resolve(resolvedRoot, relativePath);
  if (!candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new FrameworkContractError('contract_shape_invalid', `${field} escapes the package root.`, {
      field,
      root: resolvedRoot,
      relative_path: relativePath,
      failure_code: 'agent_package_managed_policy_path_invalid',
    });
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw new FrameworkContractError('contract_shape_invalid', `${field} was not found in the package payload.`, {
      field,
      path: candidate,
      failure_code: 'agent_package_managed_policy_source_missing',
    });
  }
  const resolved = fs.realpathSync(candidate);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new FrameworkContractError('contract_shape_invalid', `${field} escapes the package root.`, {
      field,
      root: resolvedRoot,
      relative_path: relativePath,
      resolved_path: resolved,
      failure_code: 'agent_package_managed_policy_path_invalid',
    });
  }
  return resolved;
}

function stringArray(value: unknown, field: string, allowEmpty = false) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new FrameworkContractError('contract_shape_invalid', `${field} must be an array of non-empty strings.`, {
      field,
      failure_code: 'agent_package_managed_policy_invalid',
    });
  }
  const normalized = [...new Set(value.map((entry) => String(entry).trim()))];
  if ((!allowEmpty && normalized.length === 0) || normalized.length !== value.length) {
    throw new FrameworkContractError('contract_shape_invalid', `${field} must contain unique values.`, {
      field,
      failure_code: 'agent_package_managed_policy_invalid',
    });
  }
  return normalized;
}

function normalizeDependency(
  value: unknown,
  field: string,
  schema: OplFlowPolicy['schema'],
): AgentPackageManagedPolicyDependency {
  if (!isRecord(value)) {
    throw new FrameworkContractError('contract_shape_invalid', `${field} must be an object.`, {
      field,
      failure_code: 'agent_package_managed_policy_invalid',
    });
  }
  const kind = value.kind;
  const offlineBundle = value.offline_bundle;
  const activation = value.activation;
  const supportedKinds = schema !== 'opl_flow_workflow_policy.v1'
    ? ['base', 'codex_skill', 'codex_plugin', 'mcp_server', 'cli', 'runtime_capability']
    : ['base', 'codex_skill', 'cli', 'runtime_capability'];
  const openComposition = schema === 'opl_flow_workflow_policy.v3'
    || schema === 'opl_flow_workflow_policy.v4';
  if (
    typeof value.id !== 'string'
    || !value.id.trim()
    || !supportedKinds.includes(String(kind))
    || (!openComposition && !['none', 'full'].includes(String(offlineBundle)))
    || (offlineBundle !== undefined && !['none', 'full'].includes(String(offlineBundle)))
    || typeof value.online_install_default !== 'boolean'
    || !['always', 'task_routed', 'explicit'].includes(String(activation))
    || (!openComposition && typeof value.source !== 'string')
    || (value.source !== undefined && typeof value.source !== 'string')
    || (value.source_path !== undefined
      && (typeof value.source_path !== 'string' || !value.source_path.trim()))
  ) {
    throw new FrameworkContractError('contract_shape_invalid', `${field} has an invalid dependency shape.`, {
      field,
      failure_code: 'agent_package_managed_policy_invalid',
    });
  }
  const v2Fields = {
    owner: value.owner,
    version_requirement: value.version_requirement,
    install_source: value.install_source,
    lifecycle_owner: value.lifecycle_owner,
    conflict_policy: value.conflict_policy,
    credential_policy: value.credential_policy,
  };
  if (openComposition && (
    (value.owner !== undefined && (typeof value.owner !== 'string' || !value.owner.trim()))
    || (value.version_requirement !== undefined
      && (typeof value.version_requirement !== 'string' || !value.version_requirement.trim()))
    || (value.install_source !== undefined
      && (typeof value.install_source !== 'string' || !value.install_source.trim()))
    || (value.lifecycle_owner !== undefined
      && (typeof value.lifecycle_owner !== 'string' || !value.lifecycle_owner.trim()))
    || (value.conflict_policy !== undefined
      && !['managed_reconcile', 'preserve_user_surface', 'fail_closed_on_collision']
        .includes(String(value.conflict_policy)))
    || (value.credential_policy !== undefined
      && !['none', 'user_or_provider_owned_not_bundled'].includes(String(value.credential_policy)))
    || (value.bundle_id !== undefined
      && (typeof value.bundle_id !== 'string' || !value.bundle_id.trim()))
    || (value.readiness_adapter !== undefined
      && ![
        'codex_skill_payload',
        'binary_version',
        'agent_reach_doctor',
        'runtime_observation',
      ].includes(String(value.readiness_adapter)))
  )) {
    throw new FrameworkContractError('contract_shape_invalid', `${field} has invalid optional lifecycle hints.`, {
      field,
      failure_code: 'agent_package_managed_policy_invalid',
    });
  }
  if (schema === 'opl_flow_workflow_policy.v2' && (
    typeof v2Fields.owner !== 'string'
    || !v2Fields.owner.trim()
    || typeof v2Fields.version_requirement !== 'string'
    || !v2Fields.version_requirement.trim()
    || !['package_payload', 'framework_managed_release_lock', 'codex_builtin', 'user_managed']
      .includes(String(v2Fields.install_source))
    || typeof v2Fields.lifecycle_owner !== 'string'
    || !v2Fields.lifecycle_owner.trim()
    || !['managed_reconcile', 'preserve_user_surface', 'fail_closed_on_collision']
      .includes(String(v2Fields.conflict_policy))
    || !['none', 'user_or_provider_owned_not_bundled'].includes(String(v2Fields.credential_policy))
  )) {
    throw new FrameworkContractError('contract_shape_invalid', `${field} is missing v2 lifecycle metadata.`, {
      field,
      failure_code: 'agent_package_managed_policy_invalid',
    });
  }
  return {
    id: value.id.trim(),
    kind: kind as AgentPackageManagedPolicyDependency['kind'],
    ...(offlineBundle === undefined
      ? {}
      : { offline_bundle: offlineBundle as AgentPackageManagedPolicyDependency['offline_bundle'] }),
    online_install_default: value.online_install_default,
    activation: activation as AgentPackageManagedPolicyDependency['activation'],
    ...(value.source === undefined ? {} : { source: value.source }),
    ...(value.source_path === undefined ? {} : { source_path: String(value.source_path).trim() }),
    ...(schema === 'opl_flow_workflow_policy.v2'
      ? {
          owner: String(v2Fields.owner).trim(),
          version_requirement: String(v2Fields.version_requirement).trim(),
          install_source: v2Fields.install_source as NonNullable<AgentPackageManagedPolicyDependency['install_source']>,
          lifecycle_owner: String(v2Fields.lifecycle_owner).trim(),
          conflict_policy: v2Fields.conflict_policy as NonNullable<AgentPackageManagedPolicyDependency['conflict_policy']>,
          credential_policy: v2Fields.credential_policy as NonNullable<AgentPackageManagedPolicyDependency['credential_policy']>,
        }
      : openComposition
        ? {
            ...(value.owner === undefined ? {} : { owner: String(value.owner).trim() }),
            ...(value.version_requirement === undefined
              ? {}
              : { version_requirement: String(value.version_requirement).trim() }),
            ...(value.install_source === undefined
              ? {}
              : { install_source: String(value.install_source).trim() }),
            ...(value.lifecycle_owner === undefined
              ? {}
              : { lifecycle_owner: String(value.lifecycle_owner).trim() }),
            ...(value.conflict_policy === undefined
              ? {}
              : {
                  conflict_policy: value.conflict_policy as NonNullable<
                    AgentPackageManagedPolicyDependency['conflict_policy']
                  >,
                }),
            ...(value.credential_policy === undefined
              ? {}
              : {
                  credential_policy: value.credential_policy as NonNullable<
                    AgentPackageManagedPolicyDependency['credential_policy']
                  >,
                }),
            ...(value.bundle_id === undefined
              ? {}
              : { bundle_id: String(value.bundle_id).trim() }),
            ...(value.readiness_adapter === undefined
              ? {}
              : {
                  readiness_adapter: value.readiness_adapter as NonNullable<
                    AgentPackageManagedPolicyDependency['readiness_adapter']
                  >,
                }),
          }
        : {}),
  };
}

function dependencyKey(value: Pick<AgentPackageManagedPolicyDependency, 'kind' | 'id'>) {
  return `${value.kind}:${value.id}`;
}

function assertUniqueDependencyIdentities(
  dependencies: AgentPackageManagedPolicyDependency[],
  field: string,
) {
  const keys = dependencies.map(dependencyKey);
  const duplicates = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];
  if (duplicates.length > 0) {
    throw new FrameworkContractError('contract_shape_invalid', `${field} contains duplicate (kind, id) identities.`, {
      field,
      duplicate_dependency_keys: duplicates,
      failure_code: 'agent_package_managed_policy_dependency_identity_duplicate',
    });
  }
}

function normalizeInstallationConvergence(value: unknown) {
  if (!isRecord(value)) {
    throw new FrameworkContractError('contract_shape_invalid', 'installation_convergence must be an object.', {
      failure_code: 'agent_package_managed_policy_convergence_invalid',
    });
  }
  const expected = {
    standard_target_closure: 'workflow_policy_release_lock',
    full_target_closure: 'workflow_policy_release_lock',
    standard_source: 'online_exact_release_lock',
    full_source: 'embedded_exact_release_lock',
    final_projection_equivalence_required: true,
    default_dependencies_require_full_bundle: true,
    secrets_bundled: false,
    user_third_party_surfaces_policy: 'preserve',
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (value[field] !== expectedValue) {
      throw new FrameworkContractError('contract_shape_invalid', 'Managed policy installation convergence is invalid.', {
        field: `installation_convergence.${field}`,
        expected: expectedValue,
        actual: value[field],
        failure_code: 'agent_package_managed_policy_convergence_invalid',
      });
    }
  }
  return value;
}

function normalizeGroups(value: unknown, field: string) {
  if (!Array.isArray(value)) {
    throw new FrameworkContractError('contract_shape_invalid', `${field} must be an array.`, {
      field,
      failure_code: 'agent_package_managed_policy_invalid',
    });
  }
  return value.map((entry, index): MigrationGroup => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.reason !== 'string') {
      throw new FrameworkContractError('contract_shape_invalid', `${field}[${index}] has an invalid migration shape.`, {
        field,
        index,
        failure_code: 'agent_package_managed_policy_invalid',
      });
    }
    const surfaceKinds = entry.surface_kinds === undefined
      ? [...MIGRATION_SURFACE_KINDS]
      : stringArray(entry.surface_kinds, `${field}[${index}].surface_kinds`);
    const invalidSurfaceKinds = surfaceKinds.filter((surfaceKind) =>
      !MIGRATION_SURFACE_KINDS.includes(surfaceKind as MigrationSurfaceKind));
    if (invalidSurfaceKinds.length > 0) {
      throw new FrameworkContractError('contract_shape_invalid', `${field}[${index}] has invalid surface kinds.`, {
        field,
        index,
        invalid_surface_kinds: invalidSurfaceKinds,
        failure_code: 'agent_package_managed_policy_invalid',
      });
    }
    return {
      id: entry.id,
      discovery_ids: stringArray(entry.discovery_ids, `${field}[${index}].discovery_ids`),
      surface_kinds: surfaceKinds as MigrationSurfaceKind[],
      auto_retire_on_optimize: entry.auto_retire_on_optimize === true,
      reason: entry.reason,
    };
  });
}

function normalizePolicy(
  payload: unknown,
  identity: Pick<ManagedPolicyIdentity, 'packageId' | 'packageVersion'>,
): OplFlowPolicy {
  if (!isRecord(payload) || !isRecord(payload.package) || !isRecord(payload.migration_policy)
    || !isRecord(payload.historical_fingerprints) || !isRecord(payload.codex_model_policy)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Managed OPL Flow policy has an invalid root shape.', {
      package_id: identity.packageId,
      failure_code: 'agent_package_managed_policy_invalid',
    });
  }
  const schema = payload.schema;
  if (
    ![
      'opl_flow_workflow_policy.v1',
      'opl_flow_workflow_policy.v2',
      'opl_flow_workflow_policy.v3',
      'opl_flow_workflow_policy.v4',
    ]
      .includes(String(schema))
    || payload.package.id !== identity.packageId
    || payload.package.version !== identity.packageVersion
    || payload.package.owner !== 'opl-flow'
    || payload.package.kind !== 'workflow_profile'
    || payload.codex_model_policy.authority !== 'opl-flow'
  ) {
    throw new FrameworkContractError('contract_shape_invalid', 'Managed policy identity or version does not match the package manifest.', {
      package_id: identity.packageId,
      package_version: identity.packageVersion,
      policy_package: payload.package,
      failure_code: 'agent_package_managed_policy_identity_mismatch',
    });
  }
  const normalizedSchema = schema as OplFlowPolicy['schema'];
  const expectedMigrationPolicy = {
    trigger: 'explicit_opl_flow_install_update_optimize_or_generic_app_post_update_reconcile',
    default_action: 'backup_disable_and_remove_from_discovery',
    physical_delete: false,
    receipt_owner: 'opl-framework',
    rollback_required: true,
    keep_override_supported: true,
    fresh_discovery_required: true,
  };
  for (const [key, expected] of Object.entries(expectedMigrationPolicy)) {
    if (payload.migration_policy[key] !== expected) {
      throw new FrameworkContractError('contract_shape_invalid', 'Managed policy migration invariants are not compatible with OPL Packages.', {
        package_id: identity.packageId,
        field: `migration_policy.${key}`,
        expected,
        actual: payload.migration_policy[key],
        failure_code: 'agent_package_managed_policy_migration_invariant_invalid',
      });
    }
  }
  const fingerprints = payload.historical_fingerprints;
  const normalizeDependencies = (value: unknown, field: string) => Array.isArray(value)
    ? value.map((entry, index) => normalizeDependency(entry, `${field}[${index}]`, normalizedSchema))
    : [];
  const provides = normalizedSchema !== 'opl_flow_workflow_policy.v1'
    ? normalizeDependencies(payload.provides, 'provides')
    : [];
  const requires = normalizeDependencies(payload.requires, 'requires');
  const recommends = normalizedSchema === 'opl_flow_workflow_policy.v4'
    ? []
    : normalizeDependencies(payload.recommends, 'recommends');
  const experienceBaseline = normalizedSchema === 'opl_flow_workflow_policy.v4'
    ? normalizeDependencies(payload.experience_baseline, 'experience_baseline')
    : [];
  const compatibleOptional = normalizeDependencies(payload.compatible_optional, 'compatible_optional');
  const capabilityBundles = normalizedSchema === 'opl_flow_workflow_policy.v4'
    ? normalizeFlowCapabilityBundles(payload.capability_bundles)
    : [];
  assertUniqueDependencyIdentities(provides, 'provides');
  assertUniqueDependencyIdentities(
    [...requires, ...recommends, ...experienceBaseline, ...compatibleOptional],
    'dependencies',
  );
  if (normalizedSchema === 'opl_flow_workflow_policy.v2') {
    const invalidProvided = provides.filter((entry) => (
      !['codex_plugin', 'codex_skill'].includes(entry.kind)
      || !entry.online_install_default
      || entry.offline_bundle !== 'full'
      || entry.install_source !== 'package_payload'
      || entry.lifecycle_owner !== 'opl-framework'
      || entry.credential_policy !== 'none'
    ));
    if (provides.length === 0 || invalidProvided.length > 0) {
      throw new FrameworkContractError('contract_shape_invalid', 'v2 provided capabilities must be package-carried Codex surfaces.', {
        invalid_provided_capability_keys: invalidProvided.map(dependencyKey),
        failure_code: 'agent_package_managed_policy_provides_invalid',
      });
    }
    const invalidDefaultDependencies = [...requires, ...recommends].filter((entry) => (
      entry.online_install_default && (
        entry.offline_bundle !== 'full'
        || entry.lifecycle_owner !== 'opl-framework'
      )
    ));
    if (invalidDefaultDependencies.length > 0) {
      throw new FrameworkContractError('contract_shape_invalid', 'Default dependencies must converge through Framework in Standard and Full.', {
        invalid_dependency_keys: invalidDefaultDependencies.map(dependencyKey),
        failure_code: 'agent_package_managed_policy_default_closure_invalid',
      });
    }
  }
  return {
    schema: normalizedSchema,
    package: payload.package as OplFlowPolicy['package'],
    workflow_generation: String(payload.workflow_generation ?? ''),
    provides,
    requires,
    recommends,
    experience_baseline: experienceBaseline,
    compatible_optional: compatibleOptional,
    capability_bundles: capabilityBundles,
    conflicts: normalizeGroups(payload.conflicts, 'conflicts'),
    retires: normalizeGroups(payload.retires, 'retires'),
    migration_policy: payload.migration_policy,
    historical_fingerprints: {
      plugin_ids: stringArray(fingerprints.plugin_ids, 'historical_fingerprints.plugin_ids'),
      skill_ids: stringArray(fingerprints.skill_ids, 'historical_fingerprints.skill_ids'),
      service_ids: stringArray(fingerprints.service_ids, 'historical_fingerprints.service_ids'),
      config_markers: stringArray(fingerprints.config_markers, 'historical_fingerprints.config_markers'),
      legacy_prompt_ids: stringArray(fingerprints.legacy_prompt_ids, 'historical_fingerprints.legacy_prompt_ids'),
    },
    codex_model_policy: normalizeCodexModelPolicy(payload.codex_model_policy),
    installation_convergence: normalizedSchema === 'opl_flow_workflow_policy.v2'
      ? normalizeInstallationConvergence(payload.installation_convergence)
      : null,
  };
}

function assertProvidedCapabilities(
  policy: OplFlowPolicy,
  identity: Pick<ManagedPolicyIdentity, 'pluginId' | 'requiredSkillIds'>,
) {
  if (policy.schema === 'opl_flow_workflow_policy.v1') return;
  const pluginIds = policy.provides.filter((entry) => entry.kind === 'codex_plugin').map((entry) => entry.id);
  const skillIds = policy.provides.filter((entry) => entry.kind === 'codex_skill').map((entry) => entry.id).sort();
  const requiredSkillIds = [...identity.requiredSkillIds].sort();
  if (
    pluginIds.length !== 1
    || pluginIds[0] !== identity.pluginId
    || skillIds.length !== requiredSkillIds.length
    || skillIds.some((skillId, index) => skillId !== requiredSkillIds[index])
  ) {
    throw new FrameworkContractError('contract_shape_invalid', 'v2 provided capabilities do not match the package carrier.', {
      policy_plugin_ids: pluginIds,
      manifest_plugin_id: identity.pluginId,
      policy_skill_ids: skillIds,
      manifest_required_skill_ids: requiredSkillIds,
      failure_code: 'agent_package_managed_policy_provides_mismatch',
    });
  }
}

function loadManagedPolicySurface(input: {
  identity: ManagedPolicyIdentity;
  sourceRoot: string;
}) {
  const { config } = input.identity;
  const policyPath = resolveInside(input.sourceRoot, config.source_path, 'managed_policy_surface.source_path');
  const schemaPath = resolveInside(input.sourceRoot, config.schema_path, 'managed_policy_surface.schema_path');
  const policyPayload = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as unknown;
  const schemaPayload = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as unknown;
  assertJsonSchemaPayload({
    schemaId: `package-policy:${input.identity.packageId}:${input.identity.packageVersion}`,
    schema: schemaPayload as Record<string, unknown>,
    sourceRef: schemaPath,
  }, policyPayload);
  const policy = normalizePolicy(policyPayload, input.identity);
  assertProvidedCapabilities(policy, input.identity);
  return {
    config,
    policy,
    policyPath,
    schemaPath,
    policySha256: sha256File(policyPath),
  };
}

export { dependencyKey, loadManagedPolicySurface, sha256File };
