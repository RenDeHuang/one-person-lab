import fs from 'node:fs';
import path from 'node:path';

import { resolveDefaultFamilyWorkspaceRoot } from '../../../authority/workspace/index.ts';
import { buildOplGuiArtifactName, buildOplReleaseTag, getOplReleaseRepo, getOplReleaseVersion } from '../opl-release.ts';

export type OplGuiShellSurface = {
  shell_id: 'opl_studio_shell';
  label: 'OPL Desktop GUI';
  owner: 'one-person-lab-app';
  base_shell: 'opl-studio';
  relation_to_opl: 'opl_first_party_application_host';
  repo_url: string;
  active_shell_root: 'shells/opl-studio';
  release_repo: string;
  release_tag: string;
  opl_release_version: string;
  sibling_checkout_path: string;
  sibling_checkout_found: boolean;
  product_identity: {
    app_name: string;
    bundle_name: string;
    required_branding: string[];
    hidden_upstream_modules: string[];
  };
  release_strategy: 'prefer_prebuilt_release_then_source_build';
  prebuilt_artifacts: Array<{
    platform: 'macos' | 'windows' | 'linux';
    architectures: string[];
    distributable_patterns: string[];
    updater_metadata: string[];
  }>;
  fallback_build_commands: string[];
  notes: string[];
};

export function buildOplGuiShellSurface(repoRoot: string): OplGuiShellSurface {
  const workspaceRoot = resolveDefaultFamilyWorkspaceRoot({ repoRootHint: repoRoot });
  const siblingCheckoutPath = path.join(workspaceRoot, 'one-person-lab-app');
  const releaseVersion = getOplReleaseVersion();

  return {
    shell_id: 'opl_studio_shell',
    label: 'OPL Desktop GUI',
    owner: 'one-person-lab-app',
    base_shell: 'opl-studio',
    relation_to_opl: 'opl_first_party_application_host',
    repo_url: 'https://github.com/gaofeng21cn/opl-studio',
    active_shell_root: 'shells/opl-studio',
    release_repo: getOplReleaseRepo(),
    release_tag: buildOplReleaseTag(releaseVersion),
    opl_release_version: releaseVersion,
    sibling_checkout_path: siblingCheckoutPath,
    sibling_checkout_found: fs.existsSync(siblingCheckoutPath) && fs.statSync(siblingCheckoutPath).isDirectory(),
    product_identity: {
      app_name: 'OPL',
      bundle_name: 'OPL.app',
      required_branding: ['One Person Lab', 'OPL iconography', 'OPL product wording'],
      hidden_upstream_modules: ['legacy team management', 'legacy scheduled tasks', 'generic upstream branding'],
    },
    release_strategy: 'prefer_prebuilt_release_then_source_build',
    prebuilt_artifacts: [
      {
        platform: 'macos',
        architectures: ['x64', 'arm64'],
        distributable_patterns: [
          buildOplGuiArtifactName({ platform: 'macos', arch: 'x64', ext: 'dmg', version: releaseVersion }),
          buildOplGuiArtifactName({ platform: 'macos', arch: 'arm64', ext: 'dmg', version: releaseVersion }),
        ],
        updater_metadata: ['latest-mac.yml', 'latest-arm64-mac.yml'],
      },
      {
        platform: 'windows',
        architectures: ['x64', 'arm64'],
        distributable_patterns: [
          buildOplGuiArtifactName({ platform: 'windows', arch: 'x64', ext: 'exe', version: releaseVersion }),
          buildOplGuiArtifactName({ platform: 'windows', arch: 'arm64', ext: 'exe', version: releaseVersion }),
        ],
        updater_metadata: ['latest.yml', 'latest-win-arm64.yml'],
      },
      {
        platform: 'linux',
        architectures: ['x64', 'arm64'],
        distributable_patterns: [
          buildOplGuiArtifactName({ platform: 'linux', arch: 'x64', ext: 'deb', version: releaseVersion }),
          buildOplGuiArtifactName({ platform: 'linux', arch: 'arm64', ext: 'deb', version: releaseVersion }),
        ],
        updater_metadata: ['latest-linux.yml', 'latest-linux-arm64.yml'],
      },
    ],
    fallback_build_commands: [
      'bun install',
      'bun run dist:mac',
      'bun run dist:win',
      'bun run dist:linux',
    ],
    notes: [
      'OPL Framework owns the runtime contract; one-person-lab-app owns product packaging and release discovery while opl-studio owns the first-party Desktop, WebUI, and Docker application host.',
      'A valid OPL GUI package is an OPL Studio Electron-builder distributable admitted and published through the App release contract.',
      'Legacy shell implementations are not runtime, install, or release fallbacks.',
      'Source build is only the fallback when no release asset matches the local platform and architecture.',
    ],
  };
}
