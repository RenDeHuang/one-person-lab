import type { OplDeveloperSupervisorConfigFile } from '../../kernel/system-preferences.ts';
import type {
  DeveloperCapabilitiesProjection,
  DeveloperCapabilityProjection,
  DeveloperCapabilityStatus,
  DeveloperModeAgentAuthorityProjection,
  DeveloperModeAllowedRoute,
  DeveloperModeRepositoryMaintenanceProtection,
  DeveloperModeStatus,
  DeveloperProfileProjection,
  GithubIdentityProjection,
  RepoAuthoritySummary,
} from './developer-mode-types.ts';

function developerCapability(
  status: DeveloperCapabilityStatus,
  level: string,
  source: string,
  impact: string,
): DeveloperCapabilityProjection {
  return {
    status,
    level,
    source,
    impact,
  };
}

export function resolveDeveloperProfile(input: {
  status: DeveloperModeStatus;
  enabled: OplDeveloperSupervisorConfigFile['enabled'];
  mode: OplDeveloperSupervisorConfigFile['mode'];
  configSource: OplDeveloperSupervisorConfigFile['source'];
  allowedRoute: DeveloperModeAllowedRoute;
  githubIdentity: GithubIdentityProjection;
  repoAuthority: RepoAuthoritySummary;
}): DeveloperProfileProjection {
  if (input.status === 'pending') {
    return {
      profile_id: 'contributor',
      status: 'not_checked',
      level: 'contributor',
      source: 'authority_inspection_pending',
      impact: 'Developer repository authority is pending a full identity and permission inspection.',
    };
  }

  if (input.status === 'disabled') {
    return {
      profile_id: 'contributor',
      status: 'disabled',
      level: 'contributor',
      source: 'developer_mode_disabled',
      impact: 'Developer Mode is disabled; repair and runtime mutation routes are not offered.',
    };
  }

  if (input.status === 'blocked') {
    return {
      profile_id: 'contributor',
      status: 'blocked',
      level: 'contributor',
      source: input.githubIdentity.status !== 'ready'
        ? 'github_identity_unavailable'
        : 'repo_authority_blocked',
      impact: 'Developer Mode repair and runtime mutation routes are blocked until GitHub identity is available.',
    };
  }

  if (input.status === 'inactive') {
    return {
      profile_id: 'contributor',
      status: 'blocked',
      level: 'contributor',
      source: 'auto_identity_mismatch',
      impact: 'Auto Developer Mode remains inactive for this GitHub identity.',
    };
  }

  if (input.allowedRoute === 'direct_repo_fix' && input.configSource === 'user_config' && input.enabled === 'on') {
    return {
      profile_id: 'runtime_maintainer',
      status: 'ready',
      level: 'runtime_maintainer',
      source: 'repo_authority_all_direct_write',
      impact: 'may use direct repository repair routes and supervised shared runtime maintenance.',
    };
  }

  if (input.allowedRoute === 'direct_repo_fix' || input.allowedRoute === 'mixed_direct_and_pr') {
    return {
      profile_id: 'maintainer',
      status: input.allowedRoute === 'mixed_direct_and_pr' ? 'limited' : 'ready',
      level: 'maintainer',
      source: input.allowedRoute === 'mixed_direct_and_pr'
        ? 'repo_authority_mixed_routes'
        : 'repo_authority_direct_write',
      impact: input.allowedRoute === 'mixed_direct_and_pr'
        ? 'May use direct repair only for repos with write authority and pull request routes elsewhere.'
        : 'May use direct repository repair routes for required OPL repos.',
    };
  }

  if (input.allowedRoute === 'observe_only') {
    return {
      profile_id: 'contributor',
      status: 'limited',
      level: 'contributor',
      source: 'developer_mode_observe_only',
      impact: 'May inspect Developer Mode state without repository or shared runtime mutation.',
    };
  }

  return {
    profile_id: 'contributor',
    status: input.status === 'limited' ? 'limited' : 'ready',
    level: 'contributor',
    source: 'repo_authority_pull_request_route',
    impact: 'May prepare fork or pull request route evidence without direct repo mutation.',
  };
}

export function resolveDeveloperCapabilities(input: {
  status: DeveloperModeStatus;
  enabled: OplDeveloperSupervisorConfigFile['enabled'];
  mode: OplDeveloperSupervisorConfigFile['mode'];
  configSource: OplDeveloperSupervisorConfigFile['source'];
  allowedRoute: DeveloperModeAllowedRoute;
  githubIdentity: GithubIdentityProjection;
  repoAuthority: RepoAuthoritySummary;
}): DeveloperCapabilitiesProjection {
  const developerApplySafe = input.enabled === 'on' && input.mode === 'developer_apply_safe';
  const explicitlyTrusted = developerApplySafe && input.configSource === 'user_config';
  const disabled = input.status === 'disabled';
  const pending = input.status === 'pending';
  const blocked = input.status === 'blocked' || input.status === 'inactive';
  const developerSourceSelected =
    input.enabled === 'on'
    || (input.enabled === 'auto' && !disabled && !blocked && !pending);
  const developerWorkspaceSelected = developerSourceSelected && input.configSource === 'user_config';

  const githubAuthority = (() => {
    if (disabled) {
      return developerCapability(
        'disabled',
        'disabled',
        'developer_mode_disabled',
        'Repository repair routes are not offered while Developer Mode is disabled.',
      );
    }
    if (pending) {
      return developerCapability(
        'not_checked',
        'permission_check_pending',
        'authority_inspection_pending',
        'Repository authority will be resolved by a full identity and permission inspection.',
      );
    }
    if (input.githubIdentity.status !== 'ready') {
      return developerCapability(
        'blocked',
        'blocked',
        'github_identity_unavailable',
        'Cannot determine direct write or pull request authority.',
      );
    }
    if (input.repoAuthority.status === 'not_checked') {
      return developerCapability(
        'not_checked',
        'permission_check_deferred',
        'fast_profile',
        'Repository authority is deferred in fast profile reads.',
      );
    }
    if (input.allowedRoute === 'direct_repo_fix') {
      return developerCapability(
        'ready',
        'direct_write',
        'github_repo_permissions',
        'All required OPL repos allow direct repair branches from this identity.',
      );
    }
    if (input.allowedRoute === 'mixed_direct_and_pr') {
      return developerCapability(
        'limited',
        'mixed_direct_and_pull_request',
        'github_repo_permissions',
        'Some required OPL repos allow direct repair branches; others require fork or pull request evidence.',
      );
    }
    if (input.allowedRoute === 'fork_pull_request') {
      return developerCapability(
        'limited',
        'pull_request',
        'github_repo_permissions',
        'Direct writes are unavailable; repairs must route through fork or pull request evidence.',
      );
    }
    return developerCapability(
      blocked ? 'blocked' : 'limited',
      input.allowedRoute,
      input.allowedRoute === 'observe_only' ? 'developer_supervisor_mode' : 'repo_authority',
      input.allowedRoute === 'observe_only'
        ? 'Repository mutation is not offered in observe-only mode.'
        : 'Repository repair route is not available.',
    );
  })();

  const sourceChannel = pending
    ? developerCapability(
      'not_checked',
      'identity_check_pending',
      'authority_inspection_pending',
      'The native module source remains selected until automatic Developer Mode identity inspection completes.',
    )
    : developerSourceSelected
    ? developerCapability(
      'ready',
      'local_checkout',
      'developer_mode_git_checkout_source',
      'Module source may use local developer checkouts for App and CLI read-models.',
    )
    : developerCapability(
      disabled ? 'disabled' : 'limited',
      'native_git_checkout',
      disabled ? 'developer_mode_disabled' : 'native_git_checkout',
      'Module source remains on the native Git checkout unless the source selector activates Developer Mode.',
    );

  const workspaceTrust = pending
    ? developerCapability(
      'not_checked',
      'developer_workspace_pending',
      'authority_inspection_pending',
      'Developer workspace trust is not elevated until automatic identity inspection completes.',
    )
    : developerWorkspaceSelected
    ? developerCapability(
      'ready',
      'trusted_developer_workspace',
      'user_config_developer_supervisor',
      'Developer workspace can be used for module checkout discovery; maintenance permission remains separately gated.',
    )
    : developerCapability(
      disabled ? 'disabled' : 'limited',
      developerApplySafe ? 'developer_workspace_unconfirmed' : 'managed_workspace',
      disabled ? 'developer_mode_disabled' : 'developer_supervisor_config',
      developerApplySafe
        ? 'Developer workspace may be used for local checkout discovery, but shared runtime mutation remains gated by explicit user config.'
        : 'Developer workspace trust is not elevated.',
    );

  const agentAutomation = pending
    ? developerCapability(
      'not_checked',
      'repo_repair_pending',
      'authority_inspection_pending',
      'Supervised repository repair routes are deferred until authority inspection completes.',
    )
    : input.mode === 'external_observe'
    ? developerCapability(
      disabled ? 'disabled' : 'limited',
      'observe_only',
      disabled ? 'developer_mode_disabled' : 'developer_supervisor_mode',
      'OPL Console can inspect state without repository repair automation.',
    )
    : developerCapability(
      blocked ? 'blocked' : disabled ? 'disabled' : 'ready',
      blocked ? 'blocked' : disabled ? 'disabled' : 'repo_repair_automation',
      blocked ? 'developer_mode_not_active' : disabled ? 'developer_mode_disabled' : 'developer_supervisor_mode',
      blocked
        ? 'Supervised repair automation is not offered until Developer Mode is active.'
        : disabled
          ? 'Supervised repair automation is disabled.'
          : 'OPL Console can expose supervised repository repair routes.',
    );

  const runtimeMutationScope = explicitlyTrusted
    ? developerCapability(
      'ready',
      'shared_runtime_maintenance',
      'explicit_developer_supervisor_user_config',
      'Shared runtime provider maintenance actions may be offered from developer checkout surfaces.',
    )
    : developerCapability(
      disabled ? 'disabled' : 'blocked',
      disabled ? 'disabled' : 'blocked_developer_checkout_shared_state',
      disabled ? 'developer_mode_disabled' : 'explicit_user_config_required',
      disabled
        ? 'Shared runtime mutation is disabled.'
        : 'Shared runtime mutation requires enabled=on, developer_apply_safe mode, and user_config source.',
    );

  return {
    source_channel: sourceChannel,
    workspace_trust: workspaceTrust,
    github_authority: githubAuthority,
    agent_automation: agentAutomation,
    runtime_mutation_scope: runtimeMutationScope,
  };
}

export function buildAgentAuthorityProjection(): DeveloperModeAgentAuthorityProjection {
  return {
    surface_kind: 'opl_developer_mode_agent_authority_policy',
    policy_id: 'developer_mode_agent_authority_matrix.v1',
    feedback_capture_requires_developer_mode: false,
    self_evolution_repo_mutation_requires_developer_mode: true,
    manual_enable_without_repo_write_cannot_grant_direct_write: true,
    activation_sources: {
      auto_github_identity: {
        can_select_local_checkout_source: true,
        can_grant_direct_repo_write: false,
      },
      manual_user_config: {
        can_request_developer_routes: true,
        no_direct_permission_route: 'fork_pull_request',
        can_grant_direct_repo_write: false,
      },
    },
    authority_levels: {
      opl_maintainer: 'may direct-fix OPL Framework and agent repos where GitHub permission allows writes',
      target_agent_developer: 'may direct-fix only the target agent repo where GitHub permission allows writes',
      contributor: 'may capture feedback and prepare fork or pull request evidence without direct mutation',
    },
    route_matrix: [
      {
        case_id: 'feedback_capture',
        route: 'observe_only',
        direct_write_required: false,
      },
      {
        case_id: 'authorized_agent_repo',
        route: 'direct_repo_fix',
        direct_write_required: true,
      },
      {
        case_id: 'manual_on_without_direct_write',
        route: 'fork_pull_request',
        direct_write_required: false,
      },
      {
        case_id: 'official_or_third_party_agent_without_authority',
        route: 'fork_pull_request',
        direct_write_required: false,
      },
    ],
  };
}

export function buildRepositoryMaintenanceProtection(): DeveloperModeRepositoryMaintenanceProtection {
  return {
    status: 'ready',
    dirty_worktree: {
      policy: 'block_in_place_mutation',
      requires_isolated_worktree: true,
      preserves_existing_changes: true,
    },
    branch: {
      policy: 'topic_branch_required',
      protected_branches: ['main', 'master'],
      direct_push_to_protected_branch: false,
    },
  };
}
