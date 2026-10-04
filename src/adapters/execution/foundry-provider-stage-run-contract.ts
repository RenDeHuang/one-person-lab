import crypto from 'node:crypto';
import path from 'node:path';

import { canonicalJsonText } from '../../kernel/canonical-json.ts';
import { FrameworkContractError, isRecord } from '../../kernel/contract-validation.ts';
import {
  foundryContentDigest,
  normalizeFoundryProviderManifest,
} from '../../authority/evolution/index.ts';
import type {
  FoundryProviderOperationInvoker,
  FoundryProviderManifest,
  FoundryActivityIdentity,
} from '../../authority/evolution/index.ts';

export type JsonRecord = Record<string, unknown>;

export function fail(message: string, details: JsonRecord = {}): never {
  throw new FrameworkContractError('contract_shape_invalid', message, details);
}

export function stringValue(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string.`);
  return value.trim();
}

export function stringList(value: unknown, field: string) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    fail(`${field} must be an array of non-empty strings.`);
  }
  return value as string[];
}

export function record(value: unknown, field: string) {
  if (!isRecord(value)) fail(`${field} must be an object.`);
  return value;
}

function sha256(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function activityKey(activity: FoundryActivityIdentity) {
  return sha256(canonicalJsonText({
    run_id: activity.run_id,
    iteration: activity.iteration,
    phase: activity.phase,
    input_digest: activity.input_digest,
  }));
}

export type FoundryProviderStageRunLaunch = {
  workflow_id: string;
};

export type FoundryProviderOperationInvocation = Parameters<FoundryProviderOperationInvoker['invoke']>[0];

export type FoundryProviderStageRunAttemptCursor = {
  stage_attempt_id: string;
  workflow_id: string;
  status: string;
};

export type FoundryProviderOperationCursorBase = {
  surface_kind: 'opl_foundry_provider_operation_cursor';
  operation_key: string;
  operation: 'design' | 'diagnose';
  provider_id: string;
  provider_manifest_digest: string;
  activity_key: string;
  required_stage_refs: string[];
  optional_stage_refs: string[];
  terminal_stage_ref: string;
  entry_workflow_id: string;
  current_workflow_id: string;
  current_stage_id: string | null;
  visited_path: Array<{ workflow_id: string; stage_id: string }>;
  continuation: {
    from_workflow_id: string;
    target_workflow_id: string;
  } | null;
  active_attempts: FoundryProviderStageRunAttemptCursor[];
  artifact_refs: string[];
  artifact_hashes: string[];
  status: 'pending' | 'terminal';
};

export type FoundryProviderOperationCursorV1 = FoundryProviderOperationCursorBase & {
  version: 'opl-foundry-provider-operation-cursor.v1';
};

export type FoundryProviderOperationCursorV2 = FoundryProviderOperationCursorBase & {
  version: 'opl-foundry-provider-operation-cursor.v2';
  provider_manifest: FoundryProviderManifest;
  provider_source_digest: string;
  checkout_root: string;
};

export type FoundryProviderOperationCursor =
  | FoundryProviderOperationCursorV1
  | FoundryProviderOperationCursorV2;

const BLUEPRINT_CONTENT_REF_FIELDS = [
  'prompt_refs',
  'skill_refs',
  'knowledge_refs',
  'helper_refs',
  'model_refs',
  'tool_refs',
  'schema_refs',
] as const;

export function blueprintContentRefs(value: unknown) {
  const envelope = record(value, 'Foundry provider protocol output');
  const blueprint = envelope.surface_kind === 'opl_foundry_evolution_proposal'
    ? record(envelope.next_blueprint, 'EvolutionProposal.next_blueprint')
    : envelope;
  const refs = record(blueprint.content_refs, 'AgentBlueprint.content_refs');
  const actualFields = Object.keys(refs).sort();
  const expectedFields = [...BLUEPRINT_CONTENT_REF_FIELDS].sort();
  if (canonicalJsonText(actualFields) !== canonicalJsonText(expectedFields)) {
    fail('AgentBlueprint.content_refs must declare the closed seven-class resource inventory.', {
      actual_fields: actualFields,
      expected_fields: expectedFields,
    });
  }
  return BLUEPRINT_CONTENT_REF_FIELDS.flatMap((field) =>
    stringList(refs[field], `AgentBlueprint.content_refs.${field}`));
}

export function assertInvocation(input: FoundryProviderOperationInvocation) {
  if (input.activity.phase !== input.operation) {
    fail('Foundry provider operation and immutable activity phase do not match.');
  }
  const operation = input.provider.operations[input.operation];
  const allowedStages = new Set([...operation.required_stage_refs, ...operation.optional_stage_refs]);
  if (!allowedStages.has(operation.entry_stage_ref) || !allowedStages.has(operation.terminal_stage_ref)) {
    fail('Foundry provider operation entry or terminal Stage is outside its declared Stage set.');
  }
  return { operation, allowedStages };
}

export function providerSourceDigest(input: FoundryProviderOperationInvocation) {
  if (!/^sha256:[a-f0-9]{64}$/.test(input.provider_source_digest)) {
    fail('Foundry provider source digest must be an exact sha256 digest.');
  }
  return input.provider_source_digest;
}

export function assertFoundryProviderOperationCursorBinding(
  cursor: FoundryProviderOperationCursor,
  operationKey: string,
) {
  if (!isRecord(cursor)) {
    fail('Foundry provider operation cursor must be an object.');
  }
  if (cursor.operation !== 'design' && cursor.operation !== 'diagnose') {
    fail('Foundry provider operation cursor declares an unsupported operation.');
  }
  if (
    cursor.surface_kind !== 'opl_foundry_provider_operation_cursor'
    || (
      cursor.version !== 'opl-foundry-provider-operation-cursor.v1'
      && cursor.version !== 'opl-foundry-provider-operation-cursor.v2'
    )
    || cursor.operation_key !== operationKey
    || typeof cursor.activity_key !== 'string'
    || !/^[a-f0-9]{64}$/.test(cursor.activity_key)
    || typeof cursor.provider_id !== 'string'
    || !cursor.provider_id.trim()
    || !/^sha256:[a-f0-9]{64}$/.test(cursor.provider_manifest_digest)
    || typeof cursor.terminal_stage_ref !== 'string'
    || !cursor.terminal_stage_ref.trim()
    || !Array.isArray(cursor.required_stage_refs)
    || cursor.required_stage_refs.some((stageId) => typeof stageId !== 'string' || !stageId.trim())
    || !Array.isArray(cursor.optional_stage_refs)
    || cursor.optional_stage_refs.some((stageId) => typeof stageId !== 'string' || !stageId.trim())
    || typeof cursor.entry_workflow_id !== 'string'
    || typeof cursor.current_workflow_id !== 'string'
    || !cursor.entry_workflow_id.trim()
    || !cursor.current_workflow_id.trim()
    || !Array.isArray(cursor.artifact_refs)
    || !Array.isArray(cursor.artifact_hashes)
    || cursor.artifact_refs.length !== cursor.artifact_hashes.length
  ) {
    fail('Foundry provider operation cursor does not bind the immutable invocation.');
  }
  if (cursor.version === 'opl-foundry-provider-operation-cursor.v1') return;
  const providerManifest = normalizeFoundryProviderManifest(cursor.provider_manifest);
  const declaredOperation = providerManifest.operations[cursor.operation];
  if (
    cursor.provider_id !== providerManifest.provider_id
    || foundryContentDigest(providerManifest) !== cursor.provider_manifest_digest
    || !/^sha256:[a-f0-9]{64}$/.test(cursor.provider_source_digest)
    || typeof cursor.checkout_root !== 'string'
    || !path.isAbsolute(cursor.checkout_root)
    || cursor.required_stage_refs.join('\0') !== declaredOperation.required_stage_refs.join('\0')
    || cursor.optional_stage_refs.join('\0') !== declaredOperation.optional_stage_refs.join('\0')
    || cursor.terminal_stage_ref !== declaredOperation.terminal_stage_ref
  ) {
    fail('Foundry provider operation cursor does not bind the immutable invocation.');
  }
}
