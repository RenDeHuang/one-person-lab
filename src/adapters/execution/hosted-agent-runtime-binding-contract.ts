import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJsonBytes, canonicalJsonText } from '../../kernel/canonical-json.ts';
import { FrameworkContractError, isRecord } from '../../kernel/contract-validation.ts';
import { parseJsonText } from '../../kernel/json-file.ts';
import type { ActivationTransaction, AgentVersion } from '../../authority/evolution/index.ts';

export const PROVENANCE_VERSION = 'opl-hosted-agent-runtime-binding-provenance.v1' as const;
export const VERSION_REGISTRY_EPOCH_VERSION = 'opl-foundry-version-registry.v1' as const;
export const VERSION_REGISTRY_EPOCH_DIRECTORY = 'epoch-v1';
export const VERSION_REGISTRY_EPOCH_MARKER = 'registry-epoch.json';

export type FoundryHostedAgentRuntimeBindingProvenance = {
  surface_kind: 'opl_hosted_agent_runtime_binding_provenance';
  version: typeof PROVENANCE_VERSION;
  source_kind: 'foundry_active_agent_version';
  target_agent_id: string;
  target_domain_id: string;
  active_version_id: string;
  active_version_digest: string;
  candidate_digest: string;
  candidate_ref: string;
  package_closure_digest: string;
  activation_revision: number;
  activation_updated_at: string;
  activation_transaction_kind: ActivationTransaction['transaction_kind'];
  prepared_runtime_binding_ref: string;
};

export type InstalledNativeHostedAgentRuntimeBindingProvenance = {
  surface_kind: 'opl_hosted_agent_runtime_binding_provenance';
  version: typeof PROVENANCE_VERSION;
  source_kind: 'installed_native_carrier';
  target_agent_id: string;
  target_domain_id: string;
  package_id: string;
  package_version: string;
  carrier_installed_version: string;
  owner_manifest_sha256: string;
  plugin_selector: string;
  marketplace_source: string;
  plugin_source_path: string;
  source_tree_sha256: string;
  action_contracts_sha256: string;
};

export type HostedAgentRuntimeBindingProvenance =
  | FoundryHostedAgentRuntimeBindingProvenance
  | InstalledNativeHostedAgentRuntimeBindingProvenance;

export type HostedAgentRuntimeBindingSnapshot = Readonly<{
  source_kind: HostedAgentRuntimeBindingProvenance['source_kind'];
  checkout_root: string;
  workspace_root: string;
  agent_id: string;
  runtime_domain_id: string;
  target_domain_id: string;
  catalog_target_domain_ids: readonly string[];
  package_use_binding: unknown;
  provenance: Readonly<HostedAgentRuntimeBindingProvenance>;
  provenance_ref: string;
}>;

export type FoundryHostedAgentPackageUseBinding = Readonly<{
  surface_kind: 'opl_agent_package_use_binding.v1';
  binding_origin: 'foundry_active_agent_version';
  use_boundary_id: string;
  root_package: Readonly<{
    package_id: string;
    package_version: string;
    owner_language_version: null;
    package_lock_ref: string;
    manifest_sha256: string;
    content_digest: string;
    source_artifact_ref: string;
    artifact_digest: string;
    owner_source_commit: null;
    carrier_authority: null;
  }>;
  provider_packages: readonly [];
  dependency_closure_digest: string;
  core_skill_tree_digest: null;
  skill_tree_digest: null;
}>;

export type FoundryHostedAgentCandidatePreflight = Readonly<{
  surface_kind: 'opl_foundry_hosted_agent_candidate_preflight';
  version: 'opl-foundry-hosted-agent-candidate-preflight.v1';
  status: 'ready';
  target_agent_id: string;
  target_domain_id: string;
  version_id: string;
  version_digest: string;
  candidate_digest: string;
  candidate_ref: string;
  checkout_root: string;
  workspace_root: string;
  catalog_target_domain_id: string;
  action_ids: readonly string[];
  package_use_binding: FoundryHostedAgentPackageUseBinding;
}>;

export interface HostedAgentRuntimeBindingResolver {
  resolve(input: { domainId: string; workspaceRoot: string }): Promise<HostedAgentRuntimeBindingSnapshot>;
  resolvePinned(input: {
    provenance: HostedAgentRuntimeBindingProvenance;
    provenance_ref: string;
    workspaceRoot: string;
  }): Promise<HostedAgentRuntimeBindingSnapshot>;
  preflightFoundryCandidate(input: {
    target_agent_id: string;
    target_domain_id: string;
    version: AgentVersion;
    candidate_directory: string;
    workspaceRoot: string;
  }): Promise<FoundryHostedAgentCandidatePreflight>;
}

export function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new FrameworkContractError('contract_shape_invalid', message, details);
}

export function sha256(value: string | Buffer) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function requireString(value: unknown, field: string) {
  if (typeof value !== 'string' || value.length === 0) fail(`${field} must be a non-empty string.`, { field });
  return value;
}

export function requireDigest(value: unknown, field: string) {
  const digest = requireString(value, field);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) fail(`${field} must be a sha256 digest.`, { field });
  return digest;
}

export function requirePackageDigest(value: unknown, field: string) {
  const digest = requireString(value, field);
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(digest)) fail(`${field} must be a package sha256 digest.`, { field });
  return digest;
}

export function existingWorkspaceRoot(input: string) {
  if (!path.isAbsolute(input)) {
    fail('Hosted Agent action requires an absolute workspace root.', { workspace_root: input });
  }
  const workspaceRoot = path.resolve(input);
  if (!fs.existsSync(workspaceRoot) || !fs.statSync(workspaceRoot).isDirectory()) {
    fail('Hosted Agent action requires an existing workspace root.', { workspace_root: input });
  }
  return fs.realpathSync.native(workspaceRoot);
}

export function physicalDirectory(directory: string, label: string) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a physical directory.`);
  return fs.realpathSync.native(directory);
}

export function readCanonicalRecord(file: string, label: string) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a physical JSON file.`);
  const bytes = fs.readFileSync(file);
  const value = parseJsonText(bytes.toString('utf8'));
  if (!isRecord(value) || !bytes.equals(canonicalJsonBytes(value))) {
    fail(`${label} must contain one canonical JSON object.`);
  }
  return value;
}

export function requiredRecord(value: unknown, field: string) {
  if (!isRecord(value)) fail(`${field} must be an object.`, { field });
  return value;
}

export function provenanceRef(provenance: HostedAgentRuntimeBindingProvenance) {
  return `opl://hosted-agent-runtime-binding/sha256/${sha256(canonicalJsonText(provenance))}`;
}

export function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}

export function freezeSnapshot(input: Omit<HostedAgentRuntimeBindingSnapshot, 'provenance' | 'catalog_target_domain_ids'> & {
  provenance: HostedAgentRuntimeBindingProvenance;
  catalog_target_domain_ids: string[];
}) {
  const provenance = Object.freeze({ ...input.provenance });
  return Object.freeze({
    ...input,
    catalog_target_domain_ids: Object.freeze([...input.catalog_target_domain_ids]),
    package_use_binding: input.package_use_binding === null || input.package_use_binding === undefined
      ? input.package_use_binding
      : deepFreeze(structuredClone(input.package_use_binding)),
    provenance,
  }) as HostedAgentRuntimeBindingSnapshot;
}
