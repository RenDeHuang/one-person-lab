import type { OplDeveloperSupervisorConfigFile } from '../../kernel/system-preferences.ts';
import { readOplDeveloperSupervisorConfig } from '../../kernel/system-preferences.ts';
import {
  detectDeveloperModeGithubIdentity,
  readDeveloperModeGhFixture,
} from './developer-mode-source-policy.ts';
import {
  buildDisabledRepoAuthority,
  buildNotCheckedRepoAuthority,
  buildRepoAuthority,
  buildSkippedIdentity,
  resolveAllowedRoute,
} from './developer-mode-repository.ts';
import {
  buildAgentAuthorityProjection,
  buildRepositoryMaintenanceProtection,
  resolveDeveloperCapabilities,
  resolveDeveloperProfile,
} from './developer-mode-capabilities.ts';
import { buildFrameworkCheckoutProjection } from './developer-mode-framework-checkout.ts';
import {
  buildTargetAuthorityProjection,
  buildTargetAuthoritySurface,
} from './developer-mode-target-authority.ts';
import type {
  DeveloperModeAllowedRoute,
  DeveloperModeContext,
  DeveloperModeEffectiveState,
  DeveloperModeStatus,
  OplDeveloperModeProjection,
  OplDeveloperModeTargetAuthorityInput,
} from './developer-mode-types.ts';
export type {
  OplDeveloperModeFrameworkCheckoutProjection,
  OplDeveloperModeProjection,
  OplDeveloperModeTargetAuthorityInput,
  OplDeveloperModeTargetAuthorityProjection,
} from './developer-mode-types.ts';

function resolveEffectiveState(
  status: DeveloperModeStatus,
  allowedRoute: DeveloperModeAllowedRoute,
): DeveloperModeEffectiveState {
  if (status === 'blocked') {
    return 'blocked';
  }
  if (allowedRoute === 'direct_repo_fix') {
    return 'active_direct';
  }
  if (allowedRoute === 'mixed_direct_and_pr') {
    return 'active_mixed_routes';
  }
  if (allowedRoute === 'observe_only') {
    return 'observe_only';
  }
  return 'active_pr_only';
}

function buildDeveloperModeProjection(input: DeveloperModeContext): OplDeveloperModeProjection {
  const common = {
    status: input.status,
    enabled: input.enabled,
    mode: input.mode,
    configSource: input.configSource,
    allowedRoute: input.allowedRoute,
    githubIdentity: input.githubIdentity,
    repoAuthority: input.repoAuthority,
  };
  return {
    surface_id: 'opl_developer_mode',
    status: input.status,
    enabled: input.enabled,
    effective_state: input.effectiveState,
    inactive_reason: input.inactiveReason,
    mode: input.mode,
    config_source: input.configSource,
    auto_enable_github_login: input.autoEnableGithubLogin,
    allowed_route: input.allowedRoute,
    developer_profile: resolveDeveloperProfile(common),
    capabilities: resolveDeveloperCapabilities(common),
    agent_authority: buildAgentAuthorityProjection(),
    framework_checkout: buildFrameworkCheckoutProjection(input),
    target_authority: buildTargetAuthoritySurface(input),
    github_identity: input.githubIdentity,
    repo_authority: input.repoAuthority,
    repository_maintenance_protection: buildRepositoryMaintenanceProtection(),
    inspection_detail: input.inspectionDetail,
  };
}

function buildDeveloperModeContext(
  config: OplDeveloperSupervisorConfigFile = readOplDeveloperSupervisorConfig(),
  options: { detail?: 'fast' | 'full' } = {},
): DeveloperModeContext {
  if (config.enabled === 'off') {
    return {
      status: 'disabled',
      enabled: config.enabled,
      effectiveState: 'disabled',
      mode: config.mode,
      configSource: config.source,
      autoEnableGithubLogin: config.auto_enable_github_login,
      allowedRoute: 'disabled',
      inactiveReason: 'developer_mode_disabled',
      githubIdentity: buildSkippedIdentity('skipped', 'developer_mode_disabled'),
      repoAuthority: buildDisabledRepoAuthority('disabled', 'developer_mode_disabled'),
      inspectionDetail: options.detail ?? 'full',
    };
  }

  if (options.detail === 'fast') {
    const repoAuthority = buildNotCheckedRepoAuthority('fast_profile_defers_github_permission_check');
    const githubIdentity = buildSkippedIdentity('skipped', 'fast_profile_defers_github_identity_check');
    if (config.enabled === 'auto') {
      return {
        status: 'pending',
        enabled: config.enabled,
        effectiveState: 'inspection_pending',
        mode: config.mode,
        configSource: config.source,
        autoEnableGithubLogin: config.auto_enable_github_login,
        allowedRoute: 'blocked',
        inactiveReason: 'authority_inspection_pending',
        githubIdentity: githubIdentity,
        repoAuthority: repoAuthority,
        inspectionDetail: 'fast',
      };
    }
    return {
      status: 'ready',
      enabled: config.enabled,
      effectiveState: config.mode === 'external_observe' ? 'observe_only' : 'active_direct',
      mode: config.mode,
      configSource: config.source,
      autoEnableGithubLogin: config.auto_enable_github_login,
      allowedRoute: config.mode === 'external_observe' ? 'observe_only' : 'direct_repo_fix',
      inactiveReason: null,
      githubIdentity: githubIdentity,
      repoAuthority: repoAuthority,
      inspectionDetail: 'fast',
    };
  }

  const fixture = readDeveloperModeGhFixture();
  const identity = detectDeveloperModeGithubIdentity(fixture);
  if (identity.status !== 'ready' || !identity.login) {
    return {
      status: 'blocked',
      enabled: config.enabled,
      effectiveState: 'blocked',
      mode: config.mode,
      configSource: config.source,
      autoEnableGithubLogin: config.auto_enable_github_login,
      allowedRoute: 'blocked',
      inactiveReason: 'github_identity_unavailable',
      githubIdentity: identity,
      repoAuthority: buildDisabledRepoAuthority('blocked', 'github_identity_unavailable'),
      inspectionDetail: 'full',
    };
  }

  if (config.enabled === 'auto' && identity.login !== config.auto_enable_github_login) {
    return {
      status: 'inactive',
      enabled: config.enabled,
      effectiveState: 'inactive_auto_identity_mismatch',
      mode: config.mode,
      configSource: config.source,
      autoEnableGithubLogin: config.auto_enable_github_login,
      allowedRoute: 'blocked',
      inactiveReason: 'auto_identity_mismatch',
      githubIdentity: identity,
      repoAuthority: buildDisabledRepoAuthority('not_checked', 'auto_identity_mismatch'),
      inspectionDetail: 'full',
    };
  }

  const repoAuthority = buildRepoAuthority(identity.login, fixture);
  if (config.mode === 'external_observe') {
    return {
      status: repoAuthority.status === 'blocked' ? 'blocked' : 'ready',
      enabled: config.enabled,
      effectiveState: repoAuthority.status === 'blocked' ? 'blocked' : 'observe_only',
      mode: config.mode,
      configSource: config.source,
      autoEnableGithubLogin: config.auto_enable_github_login,
      allowedRoute: repoAuthority.status === 'blocked' ? 'blocked' : 'observe_only',
      inactiveReason: repoAuthority.status === 'blocked' ? 'repo_authority_blocked' : null,
      githubIdentity: identity,
      repoAuthority: repoAuthority,
      inspectionDetail: 'full',
    };
  }

  const allowedRoute = resolveAllowedRoute(repoAuthority);
  const status: DeveloperModeStatus =
    repoAuthority.status === 'ready'
      ? 'ready'
      : repoAuthority.status === 'limited'
        ? 'limited'
        : 'blocked';

  return {
    status,
    enabled: config.enabled,
    effectiveState: resolveEffectiveState(status, allowedRoute),
    mode: config.mode,
    configSource: config.source,
    autoEnableGithubLogin: config.auto_enable_github_login,
    allowedRoute: allowedRoute,
    inactiveReason: status === 'blocked' ? 'repo_authority_blocked' : null,
    githubIdentity: identity,
    repoAuthority: repoAuthority,
    inspectionDetail: 'full',
  };
}

export function resolveOplDeveloperModeTargetAuthority(
  input: OplDeveloperModeTargetAuthorityInput,
  config: OplDeveloperSupervisorConfigFile = readOplDeveloperSupervisorConfig(),
  options: { detail?: 'fast' | 'full' } = {},
) {
  return buildTargetAuthorityProjection(buildDeveloperModeContext(config, options), input);
}

export function resolveOplDeveloperModeFrameworkCheckout(
  config: OplDeveloperSupervisorConfigFile = readOplDeveloperSupervisorConfig(),
  options: { detail?: 'fast' | 'full' } = {},
) {
  return buildFrameworkCheckoutProjection(buildDeveloperModeContext(config, options));
}

export function buildOplDeveloperModeProjection(
  config: OplDeveloperSupervisorConfigFile = readOplDeveloperSupervisorConfig(),
  options: { detail?: 'fast' | 'full' } = {},
): OplDeveloperModeProjection {
  return buildDeveloperModeProjection(buildDeveloperModeContext(config, options));
}
