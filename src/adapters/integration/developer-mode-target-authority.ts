import { STANDARD_AGENT_REGISTRY } from '../../kernel/standard-agent-registry.ts';
import {
  type DeveloperModeGhFixture,
  permissionAllowsDeveloperModeDirectWrite,
  readDeveloperModeGhFixture,
  readDeveloperModeRepoPermission,
} from './developer-mode-source-policy.ts';
import {
  OPL_FRAMEWORK_REPO_TARGET,
  defaultRepoUrlForRepoId,
  findRepoAuthorityProjection,
  findStandardAgentRepoTarget,
  normalizeRepoId,
  repoNameFromRepoId,
} from './developer-mode-repository.ts';
import type {
  DeveloperIdentityClass,
  DeveloperModeAllowedRoute,
  DeveloperModeContext,
  DeveloperModeTargetAuthorityStatus,
  OplDeveloperModeTargetAuthorityInput,
  OplDeveloperModeTargetAuthorityProjection,
  OplDeveloperModeTargetAuthoritySurface,
  RepoAuthorityProjection,
} from './developer-mode-types.ts';

type GhFixture = DeveloperModeGhFixture;

function resolveDeveloperIdentityClass(
  context: DeveloperModeContext,
  targetRepoId: string | null,
  directWriteAllowed: boolean,
): DeveloperIdentityClass {
  if (!directWriteAllowed || !targetRepoId) {
    return 'contributor';
  }
  const frameworkAuthority = findRepoAuthorityProjection(context.repoAuthority, OPL_FRAMEWORK_REPO_TARGET.repo);
  const targetIsFramework = normalizeRepoId(targetRepoId) === normalizeRepoId(OPL_FRAMEWORK_REPO_TARGET.repo);
  if (targetIsFramework || frameworkAuthority?.direct_write_allowed) {
    return 'opl_maintainer';
  }
  return 'target_agent_developer';
}

function buildUnresolvedTargetAuthority(
  context: DeveloperModeContext,
  input: OplDeveloperModeTargetAuthorityInput,
  reason: string,
): OplDeveloperModeTargetAuthorityProjection {
  return {
    target_kind: 'unresolved',
    resolution_source: input.target_repo_url ? 'explicit_target_repo_url' : input.target_repo_id ? 'explicit_target_repo_id' : 'unresolved',
    target_agent_id: input.target_agent_id ?? null,
    target_repo_id: normalizeRepoId(input.target_repo_id) ?? null,
    target_repo_url: input.target_repo_url?.trim() || null,
    target_label: input.target_agent_id ?? input.target_repo_id ?? input.target_repo_url ?? null,
    status: 'unresolved',
    developer_identity_class: 'contributor',
    permission: null,
    direct_write_allowed: false,
    allowed_route: context.status === 'disabled' ? 'disabled' : 'blocked',
    feedback_capture_requires_developer_mode: false,
    repo_mutation_requires_developer_mode: true,
    manual_enable_cannot_grant_direct_write: true,
    developer_mode_status: context.status,
    developer_mode_enabled: context.enabled,
    developer_mode_mode: context.mode,
    reason,
  };
}

function buildResolvedTargetAuthority(input: {
  context: DeveloperModeContext;
  target_kind: 'standard_agent' | 'capability_package' | 'explicit_repo';
  resolution_source:
    | 'standard_agent_registry'
    | 'capability_package_spec'
    | 'explicit_target_repo_id'
    | 'explicit_target_repo_url';
  target_agent_id: string | null;
  target_repo_id: string;
  target_repo_url: string;
  target_label: string | null;
  repoProjection: RepoAuthorityProjection;
}): OplDeveloperModeTargetAuthorityProjection {
  let allowedRoute: DeveloperModeAllowedRoute = input.repoProjection.allowed_route;
  let status: DeveloperModeTargetAuthorityStatus = input.repoProjection.status;
  let reason = input.repoProjection.reason;
  let directWriteAllowed = input.repoProjection.direct_write_allowed;

  if (input.context.status === 'disabled') {
    allowedRoute = 'disabled';
    status = 'disabled';
    directWriteAllowed = false;
    reason = 'developer_mode_disabled';
  } else if (input.context.status === 'pending') {
    allowedRoute = 'blocked';
    status = 'not_checked';
    directWriteAllowed = false;
    reason = 'authority_inspection_pending';
  } else if (input.context.status === 'inactive') {
    allowedRoute = 'blocked';
    status = 'blocked';
    directWriteAllowed = false;
    reason = 'auto_identity_mismatch';
  } else if (input.context.githubIdentity.status !== 'ready') {
    allowedRoute = 'blocked';
    status = 'blocked';
    directWriteAllowed = false;
    reason = 'github_identity_unavailable';
  } else if (input.context.mode === 'external_observe') {
    allowedRoute = 'observe_only';
    directWriteAllowed = false;
    reason = 'developer_mode_observe_only';
  }

  return {
    target_kind: input.target_kind,
    resolution_source: input.resolution_source,
    target_agent_id: input.target_agent_id,
    target_repo_id: input.target_repo_id,
    target_repo_url: input.target_repo_url,
    target_label: input.target_label,
    status,
    developer_identity_class: resolveDeveloperIdentityClass(input.context, input.target_repo_id, directWriteAllowed),
    permission: input.repoProjection.permission,
    direct_write_allowed: directWriteAllowed,
    allowed_route: allowedRoute,
    feedback_capture_requires_developer_mode: false,
    repo_mutation_requires_developer_mode: true,
    manual_enable_cannot_grant_direct_write: true,
    developer_mode_status: input.context.status,
    developer_mode_enabled: input.context.enabled,
    developer_mode_mode: input.context.mode,
    reason,
  };
}

function resolveExplicitRepoTarget(input: OplDeveloperModeTargetAuthorityInput) {
  const repoId = normalizeRepoId(input.target_repo_id) ?? normalizeRepoId(input.target_repo_url);
  if (!repoId) {
    return null;
  }
  return {
    target_kind: 'explicit_repo' as const,
    resolution_source: normalizeRepoId(input.target_repo_id) ? 'explicit_target_repo_id' as const : 'explicit_target_repo_url' as const,
    target_agent_id: input.target_agent_id ?? null,
    target_repo_id: repoId,
    target_repo_url: input.target_repo_url?.trim() || defaultRepoUrlForRepoId(repoId),
    target_label: input.target_agent_id ?? repoNameFromRepoId(repoId),
  };
}

function buildTargetRepoProjection(
  context: DeveloperModeContext,
  targetRepoId: string,
  targetRepoUrl: string,
  targetLabel: string | null,
): RepoAuthorityProjection {
  const knownRepoAuthority = findRepoAuthorityProjection(context.repoAuthority, targetRepoId);
  if (knownRepoAuthority) {
    return {
      ...knownRepoAuthority,
      target_id: targetRepoId,
      label: targetLabel ?? knownRepoAuthority.label,
      repo: targetRepoId,
      repo_url: targetRepoUrl,
    };
  }
  if (context.inspectionDetail === 'fast') {
    return {
      target_id: targetRepoId,
      label: targetLabel ?? targetRepoId,
      repo: targetRepoId,
      repo_url: targetRepoUrl,
      source: 'opl_framework_constant',
      status: 'not_checked',
      permission: null,
      direct_write_allowed: false,
      allowed_route: 'blocked',
      reason: 'fast_profile_defers_github_permission_check',
    };
  }
  if (context.githubIdentity.status !== 'ready' || !context.githubIdentity.login) {
    return {
      target_id: targetRepoId,
      label: targetLabel ?? targetRepoId,
      repo: targetRepoId,
      repo_url: targetRepoUrl,
      source: 'opl_framework_constant',
      status: 'blocked',
      permission: null,
      direct_write_allowed: false,
      allowed_route: 'blocked',
      reason: 'github_identity_unavailable',
    };
  }
  const permissionResult = readDeveloperModeRepoPermission(
    targetRepoId,
    context.githubIdentity.login,
    readDeveloperModeGhFixture(),
  );
  if (permissionResult.status !== 'ready') {
    return {
      target_id: targetRepoId,
      label: targetLabel ?? targetRepoId,
      repo: targetRepoId,
      repo_url: targetRepoUrl,
      source: 'opl_framework_constant',
      status: 'blocked',
      permission: null,
      direct_write_allowed: false,
      allowed_route: 'blocked',
      reason: permissionResult.reason,
    };
  }
  const directWriteAllowed = permissionAllowsDeveloperModeDirectWrite(permissionResult.permission);
  return {
    target_id: targetRepoId,
    label: targetLabel ?? targetRepoId,
    repo: targetRepoId,
    repo_url: targetRepoUrl,
    source: 'opl_framework_constant',
    status: directWriteAllowed ? 'ready' : 'limited',
    permission: permissionResult.permission,
    direct_write_allowed: directWriteAllowed,
    allowed_route: directWriteAllowed ? 'direct_repo_fix' : 'fork_pull_request',
    reason: directWriteAllowed ? null : 'direct_write_permission_missing',
  };
}

export function buildTargetAuthorityProjection(
  context: DeveloperModeContext,
  input: OplDeveloperModeTargetAuthorityInput,
): OplDeveloperModeTargetAuthorityProjection {
  if (input.target_agent_id) {
    const resolved = findStandardAgentRepoTarget(input.target_agent_id);
    if (!resolved) {
      return buildUnresolvedTargetAuthority(context, input, 'standard_agent_not_found');
    }
    return buildResolvedTargetAuthority({
      context,
      target_kind: resolved.repoTarget.source === 'capability_package_spec'
        ? 'capability_package'
        : 'standard_agent',
      resolution_source: resolved.repoTarget.source === 'capability_package_spec'
        ? 'capability_package_spec'
        : 'standard_agent_registry',
      target_agent_id: resolved.standardAgent.agent_id,
      target_repo_id: resolved.repoTarget.repo,
      target_repo_url: resolved.repoTarget.repo_url,
      target_label: resolved.standardAgent.label,
      repoProjection: buildTargetRepoProjection(
        context,
        resolved.repoTarget.repo,
        resolved.repoTarget.repo_url,
        resolved.standardAgent.label,
      ),
    });
  }

  const explicitRepo = resolveExplicitRepoTarget(input);
  if (!explicitRepo) {
    return buildUnresolvedTargetAuthority(context, input, 'target_repo_not_resolvable');
  }
  return buildResolvedTargetAuthority({
    context,
    ...explicitRepo,
    repoProjection: buildTargetRepoProjection(
      context,
      explicitRepo.target_repo_id,
      explicitRepo.target_repo_url,
      explicitRepo.target_label,
    ),
  });
}

export function buildTargetAuthoritySurface(context: DeveloperModeContext): OplDeveloperModeTargetAuthoritySurface {
  return {
    surface_kind: 'opl_developer_mode_target_authority_resolver',
    policy_id: 'developer_mode_target_authority_resolver.v1',
    accepted_inputs: ['target_agent_id', 'target_repo_id', 'target_repo_url'],
    standard_targets: STANDARD_AGENT_REGISTRY.map((entry) =>
      buildTargetAuthorityProjection(context, { target_agent_id: entry.agent_id })),
  };
}
