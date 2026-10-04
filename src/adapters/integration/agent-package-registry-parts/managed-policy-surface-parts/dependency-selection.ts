import { FrameworkContractError } from '../../../../kernel/contract-validation.ts';
import {
  OPL_COMPANION_TOOL_IDS,
  type OplCompanionToolId,
  type OplManagedSkillDependency,
} from '../../install-companions.ts';
import { dependencyKey } from './normalization.ts';
import type {
  AgentPackageManagedPolicyDependency,
  OplFlowPolicy,
} from './types.ts';

const SUPPORTED_COMPANION_TOOL_IDS = new Set<string>(OPL_COMPANION_TOOL_IDS);

function managedPolicyDependencySelection(input: {
  schema: OplFlowPolicy['schema'];
  requires: AgentPackageManagedPolicyDependency[];
  recommends: AgentPackageManagedPolicyDependency[];
  experienceBaseline: AgentPackageManagedPolicyDependency[];
}) {
  const baseline = input.schema === 'opl_flow_workflow_policy.v4'
    ? input.experienceBaseline
    : input.recommends;
  const selected = [
    ...input.requires.map((dependency) => ({
      dependency,
      relationship: 'required' as const,
    })),
    ...baseline.map((dependency) => ({
      dependency,
      relationship: 'recommended' as const,
    })),
  ].filter((entry) => entry.dependency.online_install_default);
  const toolIdsByBundle = new Map<string, OplCompanionToolId[]>();
  for (const { dependency } of selected) {
    if (dependency.kind !== 'cli' || !SUPPORTED_COMPANION_TOOL_IDS.has(dependency.id) || !dependency.bundle_id) continue;
    const current = toolIdsByBundle.get(dependency.bundle_id) ?? [];
    current.push(dependency.id as OplCompanionToolId);
    toolIdsByBundle.set(dependency.bundle_id, current);
  }
  const managedSkillDependencies: OplManagedSkillDependency[] = input.schema === 'opl_flow_workflow_policy.v3'
    || input.schema === 'opl_flow_workflow_policy.v4'
    ? selected.flatMap(({ dependency, relationship }): OplManagedSkillDependency[] => {
    if (dependency.kind !== 'codex_skill') return [];
    if (input.schema === 'opl_flow_workflow_policy.v4' && dependency.install_source === 'owner_cli') {
      if (dependency.id !== 'agent-reach' || dependency.lifecycle_owner !== 'agent-reach') {
        throw new FrameworkContractError('contract_shape_invalid', 'Owner CLI Skill adapter is not registered for this Flow capability.', {
          dependency_key: dependencyKey(dependency),
          failure_code: 'agent_package_managed_policy_dependency_adapter_missing',
        });
      }
      return [{
        id: dependency.id,
        sourceMode: 'owner_cli' as const,
        ownerToolId: 'agent-reach' as const,
        owner: dependency.owner,
        requiredTools: dependency.bundle_id ? toolIdsByBundle.get(dependency.bundle_id) ?? [] : [],
        versionRequirement: dependency.version_requirement,
        installSource: dependency.install_source,
        required: relationship === 'required',
      }];
    }
    const repositoryUrl = dependency.source?.trim() ?? '';
    const repositorySourcePath = dependency.source_path?.trim() ?? '';
    const sourcePathSegments = repositorySourcePath.split('/');
    if (
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(repositoryUrl)
      || !repositorySourcePath
      || repositorySourcePath.startsWith('/')
      || repositorySourcePath.includes('\\')
      || sourcePathSegments.some((segment) => segment === '..')
    ) {
      throw new FrameworkContractError('contract_shape_invalid', 'Managed policy Skill source must be a public GitHub repository and repository-relative source_path.', {
        dependency_key: dependencyKey(dependency),
        source: dependency.source,
        source_path: dependency.source_path,
        failure_code: 'agent_package_managed_policy_dependency_source_invalid',
      });
    }
    return [{
      id: dependency.id,
      sourceMode: 'observe_existing' as const,
      legacySource: `${repositoryUrl}#${repositorySourcePath}`,
      owner: dependency.owner,
      requiredTools: dependency.bundle_id ? toolIdsByBundle.get(dependency.bundle_id) ?? [] : [],
      versionRequirement: dependency.version_requirement,
      installSource: dependency.install_source,
      required: relationship === 'required',
    }];
  })
    : selected.flatMap(({ dependency, relationship }): OplManagedSkillDependency[] => {
      if (dependency.kind !== 'codex_skill') return [];
      const expectedSource = `skills-manager:${dependency.id}`;
      if (dependency.source?.startsWith('skills-manager:') && dependency.source !== expectedSource) {
        throw new FrameworkContractError('contract_shape_invalid', 'Legacy managed policy Skill source identity is invalid.', {
          dependency_key: dependencyKey(dependency),
          source: dependency.source,
          failure_code: 'agent_package_managed_policy_dependency_identity_mismatch',
        });
      }
      return [{
        id: dependency.id,
        sourceMode: 'observe_existing' as const,
        legacySource: dependency.source ?? dependency.id,
        owner: dependency.owner,
        requiredTools: [],
        versionRequirement: dependency.version_requirement,
        installSource: dependency.install_source,
        required: relationship === 'required',
      }];
    });
  if (
    input.schema !== 'opl_flow_workflow_policy.v3'
    && input.schema !== 'opl_flow_workflow_policy.v4'
  ) {
    const unsupported = selected
      .map(({ dependency }) => dependency)
      .filter((dependency) => {
        if (dependency.kind === 'base') return dependency.id !== 'opl-base';
        if (dependency.kind === 'codex_skill') return false;
        if (dependency.kind === 'cli') return dependency.id !== 'officecli'
          && dependency.id !== 'mineru-open-api';
        return true;
      });
    if (unsupported.length > 0) {
      throw new FrameworkContractError('contract_shape_invalid', 'Managed policy dependency has no lifecycle adapter.', {
        dependency_keys: unsupported.map(dependencyKey),
        failure_code: 'agent_package_managed_policy_dependency_adapter_missing',
      });
    }
  }
  if (input.schema === 'opl_flow_workflow_policy.v3'
    || input.schema === 'opl_flow_workflow_policy.v4') {
    const unsupported = selected
      .map(({ dependency }) => dependency)
      .filter((dependency) => {
        if (dependency.kind === 'base') return dependency.id !== 'opl-base';
        if (dependency.kind === 'codex_skill') return false;
        if (dependency.kind === 'cli') return !SUPPORTED_COMPANION_TOOL_IDS.has(dependency.id);
        return true;
      });
    if (unsupported.length > 0) {
      throw new FrameworkContractError('contract_shape_invalid', 'Managed policy dependency has no lifecycle adapter.', {
        dependency_keys: unsupported.map(dependencyKey),
        failure_code: 'agent_package_managed_policy_dependency_adapter_missing',
      });
    }
  }
  return {
    dependencies: selected.map(({ dependency, relationship }) => ({
      ...dependency,
      relationship,
    })),
    skillIds: selected
      .filter(({ dependency }) => dependency.kind === 'codex_skill')
      .map(({ dependency }) => dependency.id),
    toolIds: selected
      .filter(({ dependency }) => dependency.kind === 'cli'
        && SUPPORTED_COMPANION_TOOL_IDS.has(dependency.id))
      .map(({ dependency }) => dependency.id as OplCompanionToolId),
    managedSkillDependencies,
  };
}

export { managedPolicyDependencySelection, SUPPORTED_COMPANION_TOOL_IDS };
