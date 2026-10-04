import { resolveStandardAgent } from '../../kernel/standard-agent-registry.ts';
import { listDefaultOplDomainModuleSpecs } from './system-installation/modules.ts';
import {
  type DeveloperModeGhFixture,
  parseGithubRepoFromUrl,
  permissionAllowsDeveloperModeDirectWrite,
  readDeveloperModeGhFixture,
  readDeveloperModeRepoPermission,
} from './developer-mode-source-policy.ts';
import type {
  DeveloperModeAllowedRoute,
  GithubIdentityProjection,
  GithubIdentityStatus,
  RepoAuthorityProjection,
  RepoAuthorityStatus,
  RepoAuthoritySummary,
  RepoAuthorityTarget,
} from './developer-mode-types.ts';

type GhFixture = DeveloperModeGhFixture;

export const OPL_FRAMEWORK_REPO_TARGET: RepoAuthorityTarget = {
  target_id: 'opl_framework',
  label: 'One Person Lab Framework',
  repo: 'gaofeng21cn/one-person-lab',
  repo_url: 'https://github.com/gaofeng21cn/one-person-lab.git',
  source: 'opl_framework_constant',
};

function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9/]/g, '');
}

export function normalizeRepoId(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = parseGithubRepoFromUrl(trimmed);
  if (parsed) {
    return parsed.toLowerCase();
  }
  const repoMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (repoMatch) {
    return `${repoMatch[1]}/${repoMatch[2]}`.toLowerCase();
  }
  return null;
}

export function repoNameFromRepoId(repoId: string) {
  return repoId.split('/')[1] ?? repoId;
}

export function defaultRepoUrlForRepoId(repoId: string) {
  return `https://github.com/${repoId}.git`;
}

function buildRepoTargets(): RepoAuthorityTarget[] {
  return [
    OPL_FRAMEWORK_REPO_TARGET,
    ...listDefaultOplDomainModuleSpecs().map((entry) => {
      const repo = parseGithubRepoFromUrl(entry.repo_url);
      return {
        target_id: entry.module_id,
        label: entry.label,
        repo: repo ?? `unknown/${entry.repo_name}`,
        repo_url: entry.repo_url,
        source: entry.scope === 'capability_package'
          ? 'capability_package_spec' as const
          : 'domain_module_spec' as const,
      };
    }),
  ];
}

export function findRepoAuthorityProjection(repoAuthority: RepoAuthoritySummary, repoId: string) {
  const normalized = normalizeRepoId(repoId);
  if (!normalized) {
    return null;
  }
  return repoAuthority.repos.find((entry) => normalizeRepoId(entry.repo) === normalized) ?? null;
}

function findRepoTargetByRepoId(repoId: string) {
  const normalized = normalizeRepoId(repoId);
  if (!normalized) {
    return null;
  }
  return buildRepoTargets().find((entry) => normalizeRepoId(entry.repo) === normalized) ?? null;
}

export function findStandardAgentRepoTarget(targetAgentId: string) {
  const standardAgent = resolveStandardAgent(targetAgentId);
  if (!standardAgent) {
    return null;
  }
  const aliases = [
    standardAgent.agent_id,
    standardAgent.project,
    standardAgent.canonical_plugin_name,
    standardAgent.module_id,
    standardAgent.domain_id,
  ].map(normalizeKey);
  const repoTarget = buildRepoTargets().find((candidate) => {
    const repoId = normalizeRepoId(candidate.repo) ?? '';
    const repoName = normalizeKey(repoNameFromRepoId(repoId));
    return aliases.includes(normalizeKey(candidate.target_id))
      || aliases.includes(repoName);
  });
  if (!repoTarget) {
    return null;
  }
  return {
    standardAgent,
    repoTarget,
  };
}

export function buildDisabledRepoAuthority(status: RepoAuthorityStatus, reason: string): RepoAuthoritySummary {
  const targets = buildRepoTargets();
  return {
    status,
    required_repo_count: targets.length,
    direct_write_repo_count: 0,
    pr_route_repo_count: 0,
    blocked_repo_count: status === 'blocked' ? targets.length : 0,
    repos: targets.map((target) => ({
      ...target,
      status,
      permission: null,
      direct_write_allowed: false,
      allowed_route: status === 'disabled' ? 'disabled' : 'blocked',
      reason,
    })),
  };
}

export function buildNotCheckedRepoAuthority(reason: string): RepoAuthoritySummary {
  const targets = buildRepoTargets();
  return {
    status: 'not_checked',
    required_repo_count: targets.length,
    direct_write_repo_count: 0,
    pr_route_repo_count: 0,
    blocked_repo_count: 0,
    repos: targets.map((target) => ({
      ...target,
      status: 'not_checked',
      permission: null,
      direct_write_allowed: false,
      allowed_route: 'blocked',
      reason,
    })),
  };
}

function readRepoPermission(target: RepoAuthorityTarget, login: string, fixture: GhFixture | null) {
  return readDeveloperModeRepoPermission(target.repo, login, fixture);
}

export function buildRepoAuthority(login: string, fixture: GhFixture | null): RepoAuthoritySummary {
  const repos = buildRepoTargets().map((target): RepoAuthorityProjection => {
    const permissionResult = readRepoPermission(target, login, fixture);
    if (permissionResult.status !== 'ready') {
      return {
        ...target,
        status: 'blocked',
        permission: null,
        direct_write_allowed: false,
        allowed_route: 'blocked',
        reason: permissionResult.reason,
      };
    }

    const permission = permissionResult.permission;
    const directWriteAllowed = permissionAllowsDeveloperModeDirectWrite(permission);
    return {
      ...target,
      status: directWriteAllowed ? 'ready' : 'limited',
      permission,
      direct_write_allowed: directWriteAllowed,
      allowed_route: directWriteAllowed ? 'direct_repo_fix' : 'fork_pull_request',
      reason: directWriteAllowed ? null : 'direct_write_permission_missing',
    };
  });

  const directWriteRepoCount = repos.filter((entry) => entry.direct_write_allowed).length;
  const prRouteRepoCount = repos.filter((entry) => entry.allowed_route === 'fork_pull_request').length;
  const blockedRepoCount = repos.filter((entry) => entry.allowed_route === 'blocked').length;
  const status: RepoAuthorityStatus =
    blockedRepoCount > 0
      ? 'blocked'
      : directWriteRepoCount === repos.length
        ? 'ready'
        : 'limited';

  return {
    status,
    required_repo_count: repos.length,
    direct_write_repo_count: directWriteRepoCount,
    pr_route_repo_count: prRouteRepoCount,
    blocked_repo_count: blockedRepoCount,
    repos,
  };
}

export function resolveAllowedRoute(repoAuthority: RepoAuthoritySummary): DeveloperModeAllowedRoute {
  if (repoAuthority.status === 'blocked') {
    return 'blocked';
  }
  if (repoAuthority.direct_write_repo_count === repoAuthority.required_repo_count) {
    return 'direct_repo_fix';
  }
  if (repoAuthority.direct_write_repo_count > 0 && repoAuthority.pr_route_repo_count > 0) {
    return 'mixed_direct_and_pr';
  }
  return 'fork_pull_request';
}

export function buildSkippedIdentity(status: GithubIdentityStatus, reason: string | null): GithubIdentityProjection {
  return {
    status,
    login: null,
    source: 'not_checked',
    reason,
  };
}
