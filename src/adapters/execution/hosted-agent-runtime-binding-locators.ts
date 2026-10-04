import fs from 'node:fs';
import path from 'node:path';

import { canonicalJsonText } from '../../kernel/canonical-json.ts';
import {
  type ActivationPointer,
  type AgentVersion,
} from '../../authority/evolution/index.ts';
import { foundryStoragePaths } from '../../authority/evidence/index.ts';
import {
  fail,
  physicalDirectory,
  readCanonicalRecord,
  requireDigest,
  requireString,
  sha256,
  VERSION_REGISTRY_EPOCH_DIRECTORY,
  VERSION_REGISTRY_EPOCH_MARKER,
  VERSION_REGISTRY_EPOCH_VERSION,
} from './hosted-agent-runtime-binding-contract.ts';

export type FoundryTargetLocator = {
  target_agent_id: string;
  target_domain_id: string;
  activation: ActivationPointer | null;
};

function targetStorageKey(agentId: string, domainId: string) {
  return sha256(`${agentId}\0${domainId}`);
}

function locatorIdentity(value: Record<string, unknown>, label: string) {
  const targetAgentId = requireString(value.target_agent_id, `${label}.target_agent_id`);
  const targetDomainId = requireString(value.target_domain_id, `${label}.target_domain_id`);
  return { target_agent_id: targetAgentId, target_domain_id: targetDomainId };
}

function readRegistryEpochLocator(directory: string) {
  const markerFile = path.join(directory, VERSION_REGISTRY_EPOCH_MARKER);
  if (!fs.existsSync(markerFile)) {
    fail('Foundry version registry epoch marker is missing.', { registry_directory: directory });
  }
  const value = readCanonicalRecord(markerFile, 'Foundry version registry epoch marker');
  const expectedFields = ['surface_kind', 'target_agent_id', 'target_domain_id', 'version'];
  if (
    canonicalJsonText(Object.keys(value).sort()) !== canonicalJsonText(expectedFields)
    || value.surface_kind !== 'opl_foundry_version_registry_epoch'
    || value.version !== VERSION_REGISTRY_EPOCH_VERSION
  ) {
    fail('Foundry version registry epoch marker is invalid.', { registry_directory: directory });
  }
  return locatorIdentity(value, 'Foundry version registry epoch marker');
}

function readActivationLocator(file: string) {
  const value = readCanonicalRecord(file, 'Foundry ActivationPointer locator');
  const identity = locatorIdentity(value, 'ActivationPointer');
  const activeVersionDigest = value.active_version_digest === null
    ? null
    : requireDigest(value.active_version_digest, 'ActivationPointer.active_version_digest');
  if (
    value.surface_kind !== 'opl_foundry_activation_pointer'
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
    || (value.updated_at !== null && (typeof value.updated_at !== 'string' || !Number.isFinite(Date.parse(value.updated_at))))
  ) {
    fail('Foundry ActivationPointer locator is invalid.');
  }
  return {
    ...identity,
    activation: {
      surface_kind: 'opl_foundry_activation_pointer' as const,
      ...identity,
      active_version_digest: activeVersionDigest,
      revision: value.revision as number,
      updated_at: value.updated_at as string | null,
    },
  };
}

function readVersionLocator(directory: string) {
  if (!fs.existsSync(directory)) return [];
  const realDirectory = physicalDirectory(directory, 'Foundry AgentVersion locator');
  return fs.readdirSync(realDirectory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
        fail('Foundry AgentVersion locator contains a forbidden entry.', { entry: entry.name });
      }
      const value = readCanonicalRecord(path.join(realDirectory, entry.name), 'Foundry AgentVersion locator');
      if (value.surface_kind !== 'opl_foundry_agent_version') fail('Foundry AgentVersion locator surface is invalid.');
      return locatorIdentity(value, 'AgentVersion');
    });
}

export function scanFoundryTargetLocators(rootOverride?: string) {
  const registryRoot = foundryStoragePaths(rootOverride).registry;
  if (!fs.existsSync(registryRoot)) return [];
  const realRegistryRoot = physicalDirectory(registryRoot, 'Foundry version registry locator');
  return fs.readdirSync(realRegistryRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry): FoundryTargetLocator => {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(entry.name)) {
        fail('Foundry version registry locator contains a forbidden entry.', { entry: entry.name });
      }
      const targetDirectory = physicalDirectory(
        path.join(realRegistryRoot, entry.name),
        'Foundry version registry target locator',
      );
      const targetEntries = fs.readdirSync(targetDirectory, { withFileTypes: true });
      if (
        targetEntries.length !== 1
        || targetEntries[0]?.name !== VERSION_REGISTRY_EPOCH_DIRECTORY
        || !targetEntries[0].isDirectory()
        || targetEntries[0].isSymbolicLink()
      ) {
        fail('Foundry version registry target locator must contain only the current epoch.', {
          registry_key: entry.name,
          entries: targetEntries.map((candidate) => candidate.name).sort(),
        });
      }
      const directory = physicalDirectory(
        path.join(targetDirectory, VERSION_REGISTRY_EPOCH_DIRECTORY),
        'Foundry version registry epoch locator',
      );
      const allowedEpochEntries = new Set([
        VERSION_REGISTRY_EPOCH_MARKER,
        'activation.json',
        'agent-versions',
        'qualifications',
        'activation-transactions',
      ]);
      const forbiddenEpochEntries = fs.readdirSync(directory)
        .filter((candidate) => !allowedEpochEntries.has(candidate))
        .sort();
      if (forbiddenEpochEntries.length > 0) {
        fail('Foundry version registry epoch locator contains forbidden entries.', {
          registry_key: entry.name,
          entries: forbiddenEpochEntries,
        });
      }
      const epochLocator = readRegistryEpochLocator(directory);
      const activationFile = path.join(directory, 'activation.json');
      const activationLocator = fs.existsSync(activationFile) ? readActivationLocator(activationFile) : null;
      const versionLocators = readVersionLocator(path.join(directory, 'agent-versions'));
      const identities = [
        epochLocator,
        ...(activationLocator ? [activationLocator] : []),
        ...versionLocators,
      ];
      const identity = identities[0]!;
      if (identities.some((candidate) => (
        candidate.target_agent_id !== identity.target_agent_id
        || candidate.target_domain_id !== identity.target_domain_id
      ))) {
        fail('Foundry version registry locator contains mixed target identities.', { registry_key: entry.name });
      }
      if (entry.name !== targetStorageKey(identity.target_agent_id, identity.target_domain_id)) {
        fail('Foundry version registry locator address does not match its target identity.', {
          registry_key: entry.name,
          target_agent_id: identity.target_agent_id,
          target_domain_id: identity.target_domain_id,
        });
      }
      return {
        ...identity,
        activation: activationLocator?.activation ?? null,
      };
    });
}

export function exactCandidateDirectory(rootOverride: string | undefined, version: AgentVersion) {
  requireDigest(version.candidate_digest, 'AgentVersion.candidate_digest');
  const candidates = foundryStoragePaths(rootOverride).candidates;
  const realCandidateRoot = physicalDirectory(candidates, 'Foundry candidate root');
  const directory = path.join(realCandidateRoot, version.candidate_digest.slice('sha256:'.length));
  if (!fs.existsSync(directory)) {
    fail('Active Foundry AgentVersion candidate bytes are missing.', { candidate_digest: version.candidate_digest });
  }
  const realDirectory = physicalDirectory(directory, 'Active Foundry candidate directory');
  if (!realDirectory.startsWith(`${realCandidateRoot}${path.sep}`)) {
    fail('Active Foundry candidate directory escapes immutable storage.', { candidate_digest: version.candidate_digest });
  }
  return realDirectory;
}
