import { patched, upsertSearchAttributes } from '@temporalio/workflow';
import { FrameworkContractError } from '../../kernel/contract-validation.ts';
import type {
  StageAttemptExecutionContentBinding,
  TemporalStageAttemptWorkflowInput,
  TemporalStageAttemptWorkflowState,
  TemporalStageAttemptSignalPayload,
  TemporalStageRunWorkflowInput,
  TemporalStageRunWorkflowState,
} from './family-runtime-temporal.ts';
import {
  STAGE_QUALITY_HARD_STOP_CLASSES,
  normalizeStageQualityArtifactIdentity,
  validateStageQualityFindings,
  validateStageQualityRepairMap,
  type StageQualityFinding,
  type StageQualityFindingClosure,
  type StageQualityHardStopClass,
  type StageQualityRepairMapEntry,
} from '../../authority/stages/public/stage-quality-cycle.ts';
import { aggregateStageQualityScopeTokenUsage } from '../../authority/stages/public/review-evidence-currentness.ts';

export function nowIso() {
  return new Date(Date.now()).toISOString();
}

export function asStringList(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry)) : [];
}

export function asRecordList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
    : [];
}

export function requiredRecordList(value: unknown, field: string) {
  if (!Array.isArray(value)) {
    throw new FrameworkContractError('contract_shape_invalid', `${field} must be an array.`, { field });
  }
  return asRecordList(value);
}

export function asRecord(value: unknown) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

type WorkflowScopeCarrier = {
  scope_kind?: unknown;
  execution_scope?: unknown;
};

const WORKFLOW_EXECUTION_SCOPE_FIELDS = [
  'surface_kind',
  'version',
  'scope_kind',
  'project_scope_id',
  'work_item_scope_id',
  'domain_id',
  'domain_work_item_id',
  'workspace_binding_id',
  'binding_version_id',
  'workspace_root',
  'canonical_work_item_root',
  'inventory_digest',
  'source_alias_fields',
  'scope_digest',
] as const;

export function workflowScopeKind(value: WorkflowScopeCarrier) {
  return value.scope_kind ?? (value.execution_scope ? 'work_item' : 'domain');
}

function comparableWorkflowScopeField(value: unknown) {
  return Array.isArray(value) ? JSON.stringify(value) : value;
}

export function assertWorkflowExecutionScopeIdentity(input: {
  expected: WorkflowScopeCarrier;
  actual: WorkflowScopeCarrier;
  operation: string;
}) {
  const expectedKind = workflowScopeKind(input.expected);
  const actualKind = workflowScopeKind(input.actual);
  const mismatches: Array<{ field: string; expected: unknown; actual: unknown }> = [];
  if (expectedKind !== actualKind) {
    mismatches.push({ field: 'scope_kind', expected: expectedKind, actual: actualKind });
  }
  const expectedScope = asRecord(input.expected.execution_scope);
  const actualScope = asRecord(input.actual.execution_scope);
  if (expectedKind === 'work_item' || actualKind === 'work_item') {
    const expectedKeys = Object.keys(expectedScope).sort();
    const actualKeys = Object.keys(actualScope).sort();
    if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
      mismatches.push({ field: 'execution_scope.keys', expected: expectedKeys, actual: actualKeys });
    }
    for (const field of WORKFLOW_EXECUTION_SCOPE_FIELDS) {
      const expected = comparableWorkflowScopeField(expectedScope[field]);
      const actual = comparableWorkflowScopeField(actualScope[field]);
      if (expected !== actual) mismatches.push({ field, expected, actual });
    }
  } else if (Object.keys(expectedScope).length > 0 || Object.keys(actualScope).length > 0) {
    mismatches.push({
      field: 'execution_scope',
      expected: Object.keys(expectedScope).length > 0 ? expectedScope : null,
      actual: Object.keys(actualScope).length > 0 ? actualScope : null,
    });
  }
  if (mismatches.length > 0) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Temporal workflow execution scope lineage is inconsistent.',
      {
        failure_code: 'temporal_workflow_execution_scope_mismatch',
        operation: input.operation,
        mismatches,
      },
    );
  }
}

export function assertWorkflowAttemptIdentity(input: {
  expected: TemporalStageAttemptWorkflowInput;
  actual: TemporalStageAttemptWorkflowState;
}) {
  const mismatches = [
    ['stage_attempt_id', input.expected.stage_attempt_id, input.actual.stage_attempt_id],
    ['workflow_id', input.expected.workflow_id, input.actual.workflow_id],
    ['domain_id', input.expected.domain_id, input.actual.domain_id],
    ['stage_id', input.expected.stage_id, input.actual.stage_id],
  ].flatMap(([field, expected, actual]) => expected === actual
    ? []
    : [{ field, expected, actual }]);
  if (mismatches.length > 0) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Temporal child StageAttempt returned a different runtime identity.',
      { failure_code: 'temporal_child_attempt_identity_mismatch', mismatches },
    );
  }
  assertWorkflowExecutionScopeIdentity({
    expected: input.expected,
    actual: input.actual,
    operation: 'stage_run_child_attempt_result',
  });
}

export function finiteNonNegativeInteger(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function observedAttemptTotalTokens(state: TemporalStageAttemptWorkflowState) {
  const observations = state.activity_events.flatMap((event) => {
    const direct = finiteNonNegativeInteger(asRecord(event.token_usage).total_tokens);
    const costSummary = asRecord(event.cost_summary);
    const nested = finiteNonNegativeInteger(asRecord(costSummary.token_usage).total_tokens);
    return [direct, nested].filter((value): value is number => value !== null);
  });
  return observations.length > 0 ? Math.max(...observations) : null;
}

export function findingPriorities(findings: StageQualityFinding[]) {
  return findings
    .filter((finding) => finding.required)
    .map((finding) => finding.severity === 'critical' ? 'p0' as const
      : finding.severity === 'major' ? 'p1' as const
        : 'p2' as const);
}

export function qualityScopeBudgetUsage(
  state: TemporalStageRunWorkflowState,
  includeManagedAttemptsUsed: boolean,
) {
  const tokenObservations = state.attempts.map((attempt) => attempt.total_tokens_observed);
  const tokenUsage = aggregateStageQualityScopeTokenUsage(tokenObservations);
  const elapsedMs = Math.max(0, Date.parse(state.updated_at) - Date.parse(state.started_at));
  return {
    attempts_used: state.repair_rounds_used,
    ...(includeManagedAttemptsUsed ? { managed_attempts_used: state.attempts.length } : {}),
    elapsed_ms: Number.isFinite(elapsedMs) ? elapsedMs : 0,
    ...tokenUsage,
  };
}

export function executionPolicyForAttempt(input: TemporalStageAttemptWorkflowInput) {
  const binding = input.execution_content_binding;
  if (!binding) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Stage quality controller requires the materialized Attempt execution content binding.',
      {
        failure_code: 'stage_attempt_execution_content_binding_missing',
        stage_attempt_id: input.stage_attempt_id,
      },
    );
  }
  const policy = asRecord(binding.spec.quality_policy.body);
  const formalReview = asRecord(policy.formal_review);
  const required = formalReview.required;
  const maxRepairRounds = formalReview.max_repair_rounds;
  if (
    typeof required !== 'boolean'
    || !Number.isInteger(maxRepairRounds)
    || (maxRepairRounds as number) < 0
    || (maxRepairRounds as number) > 3
    || !Array.isArray(binding.spec.quality_rubric_refs)
    || binding.spec.quality_rubric_refs.length === 0
    || !Array.isArray(binding.declared_stage_ids)
    || !binding.declared_stage_ids.includes(input.stage_id)
  ) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Stage quality controller received an invalid Attempt execution policy binding.',
      {
        failure_code: 'stage_attempt_execution_policy_invalid',
        stage_attempt_id: input.stage_attempt_id,
      },
    );
  }
  return {
    binding: binding as StageAttemptExecutionContentBinding,
    formalReviewRequired: required,
    maxRepairRounds: maxRepairRounds as number,
    rubricRefs: binding.spec.quality_rubric_refs,
    declaredStageIds: binding.declared_stage_ids,
  };
}

export function upsertStageAttemptVisibility(input: {
  enabled?: boolean;
  status: TemporalStageAttemptWorkflowState['status'];
  phase: string;
  blockedReason?: string | null;
}) {
  if (!input.enabled || !patched('opl-stage-attempt-visibility-status-v1')) {
    return;
  }
  if (patched('opl-stage-attempt-minimal-visibility-index-v1')) {
    return;
  }
  upsertSearchAttributes({
    OplAttemptStatus: [input.status],
    OplStagePhase: [input.phase],
    OplBlockedReason: input.blockedReason ? [input.blockedReason] : [],
  });
}

export function closeoutRefsFrom(value: Record<string, unknown>) {
  return [
    ...asStringList(value.closeout_refs),
    ...(typeof value.closeout_ref === 'string' ? [value.closeout_ref] : []),
    ...(typeof value.receipt_ref === 'string' ? [value.receipt_ref] : []),
  ];
}

export function closeoutPacketFromCodexResult(value: Record<string, unknown>) {
  const closeout = asRecord(value.closeout_packet);
  return Object.keys(closeout).length > 0 ? closeout : null;
}

export function validateCloseoutPacketForWorkflow(input: {
  closeoutPacket: Record<string, unknown> | null;
  workflowInput: TemporalStageAttemptWorkflowInput;
}) {
  const closeoutPacket = input.closeoutPacket;
  if (!closeoutPacket) {
    return { closeoutPacket: null, providerBlocker: null };
  }
  const closeoutAttemptId = typeof closeoutPacket.stage_attempt_id === 'string' && closeoutPacket.stage_attempt_id.trim()
    ? closeoutPacket.stage_attempt_id.trim()
    : null;
  const workItemScoped = workflowScopeKind(input.workflowInput) === 'work_item';
  if (
    (closeoutAttemptId && closeoutAttemptId !== input.workflowInput.stage_attempt_id)
    || (workItemScoped && !closeoutAttemptId)
  ) {
    return {
      closeoutPacket: null,
      providerBlocker: {
        blocked_reason: 'typed_closeout_stage_attempt_id_mismatch',
        route_impact: {
          provider_blocker_reason: 'typed_closeout_stage_attempt_id_mismatch',
          provider_blocker_surface: 'codex_stage_activity.closeout_packet.stage_attempt_id',
          expected_stage_attempt_id: input.workflowInput.stage_attempt_id,
          actual_stage_attempt_id: closeoutAttemptId,
        },
      },
    };
  }
  const closeoutStageRunId = typeof closeoutPacket.stage_run_id === 'string' && closeoutPacket.stage_run_id.trim()
    ? closeoutPacket.stage_run_id.trim()
    : null;
  if (
    (closeoutStageRunId && closeoutStageRunId !== (input.workflowInput.stage_run_id ?? null))
    || (workItemScoped && !closeoutStageRunId)
  ) {
    return {
      closeoutPacket: null,
      providerBlocker: {
        blocked_reason: closeoutStageRunId
          ? 'typed_closeout_stage_run_id_mismatch'
          : 'typed_closeout_stage_run_id_missing',
        route_impact: {
          provider_blocker_reason: closeoutStageRunId
            ? 'typed_closeout_stage_run_id_mismatch'
            : 'typed_closeout_stage_run_id_missing',
          provider_blocker_surface: 'codex_stage_activity.closeout_packet.stage_run_id',
          expected_stage_run_id: input.workflowInput.stage_run_id ?? null,
          actual_stage_run_id: closeoutStageRunId,
        },
      },
    };
  }
  if (workItemScoped) {
    const expectedScope = asRecord(input.workflowInput.execution_scope);
    const closeoutScope = asRecord(closeoutPacket.execution_scope);
    const actualScopeDigest = typeof closeoutPacket.scope_digest === 'string'
      ? closeoutPacket.scope_digest
      : typeof closeoutScope.scope_digest === 'string'
        ? closeoutScope.scope_digest
        : null;
    if (actualScopeDigest !== expectedScope.scope_digest) {
      return {
        closeoutPacket: null,
        providerBlocker: {
          blocked_reason: actualScopeDigest
            ? 'typed_closeout_execution_scope_mismatch'
            : 'typed_closeout_execution_scope_missing',
          route_impact: {
            provider_blocker_reason: actualScopeDigest
              ? 'typed_closeout_execution_scope_mismatch'
              : 'typed_closeout_execution_scope_missing',
            provider_blocker_surface: 'codex_stage_activity.closeout_packet.scope_digest',
            expected_scope_digest: expectedScope.scope_digest ?? null,
            actual_scope_digest: actualScopeDigest,
          },
        },
      };
    }
    if (Object.keys(closeoutScope).length > 0) {
      try {
        assertWorkflowExecutionScopeIdentity({
          expected: input.workflowInput,
          actual: { scope_kind: 'work_item', execution_scope: closeoutScope },
          operation: 'typed_closeout',
        });
      } catch {
        return {
          closeoutPacket: null,
          providerBlocker: {
            blocked_reason: 'typed_closeout_execution_scope_mismatch',
            route_impact: {
              provider_blocker_reason: 'typed_closeout_execution_scope_mismatch',
              provider_blocker_surface: 'codex_stage_activity.closeout_packet.execution_scope',
              expected_scope_digest: expectedScope.scope_digest ?? null,
              actual_scope_digest: actualScopeDigest,
            },
          },
        };
      }
    }
  }
  return { closeoutPacket, providerBlocker: null };
}

export function validateOperatorActionPayload(
  signal: TemporalStageAttemptSignalPayload,
  workflowInput?: TemporalStageAttemptWorkflowInput,
) {
  if (workflowInput && workflowScopeKind(workflowInput) === 'work_item') {
    const expectedScope = asRecord(workflowInput.execution_scope);
    const mismatches = [
      ['stage_attempt_id', workflowInput.stage_attempt_id, signal.payload.stage_attempt_id],
      ['stage_run_id', workflowInput.stage_run_id ?? null, signal.payload.stage_run_id],
      ['scope_digest', expectedScope.scope_digest ?? null, signal.payload.scope_digest],
    ].flatMap(([field, expected, actual]) => expected === actual
      ? []
      : [{ field, expected, actual: actual ?? null }]);
    if (mismatches.length > 0) {
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'Temporal operator ingress does not match the work-item StageAttempt identity.',
        { failure_code: 'temporal_operator_ingress_identity_mismatch', mismatches },
      );
    }
  }
  if (signal.signal_kind === 'human_gate') {
    const humanGateRef = typeof signal.payload.human_gate_ref === 'string'
      ? signal.payload.human_gate_ref.trim()
      : '';
    if (!humanGateRef) {
      throw new Error('human_gate update requires payload.human_gate_ref');
    }
  }
  if (signal.signal_kind === 'owner_receipt') {
    const ownerReceiptRef = typeof signal.payload.owner_receipt_ref === 'string'
      ? signal.payload.owner_receipt_ref.trim()
      : '';
    if (!ownerReceiptRef) {
      throw new Error('owner_receipt update requires payload.owner_receipt_ref');
    }
  }
  if (signal.signal_kind === 'user_instruction') {
    const instructionRef = typeof signal.payload.instruction_ref === 'string'
      ? signal.payload.instruction_ref.trim()
      : '';
    if (!instructionRef) {
      throw new Error('user_instruction update requires payload.instruction_ref');
    }
  }
  if (signal.signal_kind === 'resume') {
    const reason = typeof signal.payload.reason === 'string'
      ? signal.payload.reason.trim()
      : '';
    const resumeRef = typeof signal.payload.resume_ref === 'string'
      ? signal.payload.resume_ref.trim()
      : '';
    if (!reason && !resumeRef) {
      throw new Error('resume update requires payload.reason or payload.resume_ref');
    }
  }
}
export function qualityEnvelopeFromAttempt(state: TemporalStageAttemptWorkflowState) {
  const closeout = asRecord(state.closeout_packet);
  const routeImpact = asRecord(closeout.route_impact);
  return asRecord(routeImpact.stage_quality_cycle);
}

export function executionSessionRefFromAttemptState(state: TemporalStageAttemptWorkflowState) {
  for (let index = state.activity_events.length - 1; index >= 0; index -= 1) {
    const event = asRecord(state.activity_events[index]);
    if (event.activity_kind !== 'codex_stage_activity') continue;
    const progress = asRecord(event.progress_summary);
    if (typeof progress.execution_session_ref === 'string' && progress.execution_session_ref) {
      return progress.execution_session_ref;
    }
    if (typeof progress.thread_id === 'string' && progress.thread_id) {
      return `codex://threads/${progress.thread_id}`;
    }
  }
  return null;
}

export function qualityArtifactIdentity(
  state: TemporalStageAttemptWorkflowState,
  value: Record<string, unknown>,
  requireDeclaredArtifactIdentity: boolean,
  inputIdentity?: {
    artifactRefs: string[];
    artifactHashes: string[];
    artifactIdentityReceiptRefs: string[];
  },
  structuredReviewerIdentityFailure = false,
) {
  const sourceAttemptRef = `opl://stage_attempts/${state.stage_attempt_id}`;
  const declaredArtifactRefs = Array.isArray(value.artifact_refs) ? value.artifact_refs : [];
  const declaredArtifactHashes = Array.isArray(value.artifact_hashes) ? value.artifact_hashes : [];
  if (declaredArtifactRefs.length === 0 && declaredArtifactHashes.length === 0 && inputIdentity) {
    return inputIdentity;
  }
  const closeout = asRecord(state.closeout_packet);
  const closeoutAuthority = asRecord(closeout.authority_boundary);
  const legacyRawArtifactIdentity = !requireDeclaredArtifactIdentity
    && closeoutAuthority.opl === 'raw_executor_output_progress_envelope_only'
    ? asRecordList(closeout.closeout_ref_metadata)
      .filter((entry) => entry.ref_kind === 'raw_executor_output')
      .map((entry) => ({
        ref: typeof entry.ref === 'string' ? entry.ref : typeof entry.uri === 'string' ? entry.uri : null,
        hash: typeof entry.sha256 === 'string' ? entry.sha256 : null,
      }))
      .filter((entry): entry is { ref: string; hash: string } => Boolean(entry.ref && entry.hash))
    : [];
  const artifactIdentity = normalizeStageQualityArtifactIdentity({
    artifactRefs: declaredArtifactRefs.length > 0
      ? declaredArtifactRefs
      : legacyRawArtifactIdentity.map((entry) => entry.ref),
    artifactHashes: declaredArtifactHashes.length > 0
      ? declaredArtifactHashes
      : legacyRawArtifactIdentity.map((entry) => entry.hash),
    allowEmpty: true,
  });
  const artifactRefs = artifactIdentity.artifact_refs;
  const artifactHashes = artifactIdentity.artifact_hashes;
  if (artifactRefs.length === 0) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Stage quality producer or repairer did not declare a consumable artifact identity in stage_quality_cycle.',
      {
        hard_stop_class: 'zero_consumable_artifact',
        blocked_reason: 'stage_quality_attempt_without_consumable_artifact',
        source_attempt_ref: sourceAttemptRef,
        artifact_ref_count: artifactRefs.length,
        artifact_hash_count: artifactHashes.length,
      },
    );
  }
  if (
    inputIdentity
    && (
      JSON.stringify(artifactRefs) !== JSON.stringify(inputIdentity.artifactRefs)
      || JSON.stringify(artifactHashes) !== JSON.stringify(inputIdentity.artifactHashes)
    )
  ) {
    if (structuredReviewerIdentityFailure) {
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'Reviewer Attempt cannot replace the exact artifact identity it was asked to review.',
        {
          hard_stop_class: 'stale_or_mismatched_stage_identity',
          blocked_reason: 'reviewed_artifact_identity_mismatch',
          source_attempt_ref: sourceAttemptRef,
        },
      );
    }
    throw new Error('Reviewer Attempt cannot replace the exact artifact identity it was asked to review.');
  }
  if (inputIdentity) return inputIdentity;

  const metadata = asRecordList(closeout.closeout_ref_metadata);
  const receiptRefs = artifactRefs.map((artifactRef, index) => {
    const entry = metadata.find((candidate) => candidate.ref === artifactRef || candidate.uri === artifactRef);
    if (!entry || typeof entry.sha256 !== 'string' || entry.sha256 !== artifactHashes[index]) {
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'Producer and repairer artifact identity must match transport-verified closeout_ref_metadata SHA receipts.',
        {
          hard_stop_class: 'stale_or_mismatched_stage_identity',
          blocked_reason: 'artifact_byte_identity_mismatch',
          source_attempt_ref: sourceAttemptRef,
          artifact_ref: artifactRef,
        },
      );
    }
    if (typeof entry.artifact_identity_receipt_ref !== 'string' || !entry.artifact_identity_receipt_ref.trim()) {
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'Producer and repairer artifacts require a verified artifact identity receipt before formal Review.',
        {
          hard_stop_class: 'authority_boundary_violation',
          blocked_reason: 'artifact_identity_receipt_missing_authority_violation',
          source_attempt_ref: sourceAttemptRef,
          artifact_ref: artifactRef,
        },
      );
    }
    return entry.artifact_identity_receipt_ref.trim();
  });
  return {
    artifactRefs,
    artifactHashes,
    artifactIdentityReceiptRefs: receiptRefs,
  };
}

export function findingList(value: unknown, field = 'findings') {
  return validateStageQualityFindings(requiredRecordList(value, field) as StageQualityFinding[]);
}

export function repairMapList(value: unknown, findings: StageQualityFinding[]) {
  return validateStageQualityRepairMap({
    findings,
    repairMap: asRecordList(value) as StageQualityRepairMapEntry[],
  });
}

export function findingClosureList(value: unknown) {
  return requiredRecordList(value, 'finding_closures') as StageQualityFindingClosure[];
}

export function stageRunQualityCycleId(input: TemporalStageRunWorkflowInput) {
  return `quality-cycle:${input.stage_run_id}`;
}

export function validateWorkflowStageRunInput(input: TemporalStageRunWorkflowInput) {
  for (const [field, value] of Object.entries({
    stage_run_id: input.stage_run_id,
    quality_policy_ref: input.quality_policy_ref,
    domain_pack_root: input.domain_pack_root,
    stage_manifest_ref: input.stage_manifest_ref,
    stage_manifest_sha256: input.stage_manifest_sha256,
  })) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`StageRun pack binding requires ${field}.`);
    }
  }
  const roleKeys = Object.keys(input.role_prompt_refs ?? {}).sort();
  if (JSON.stringify(roleKeys) !== JSON.stringify(['producer', 're_reviewer', 'repairer', 'reviewer'])) {
    throw new Error('StageRun role_prompt_refs must use only producer, reviewer, repairer, and re_reviewer.');
  }
  const maxRepairRounds = input.quality_policy?.formal_review?.max_repair_rounds;
  if (!Number.isInteger(maxRepairRounds) || maxRepairRounds < 0 || maxRepairRounds > 3) {
    throw new Error('StageRun quality repair budget must be between zero and three.');
  }
  if (!Array.isArray(input.quality_rubric_refs) || input.quality_rubric_refs.length === 0) {
    throw new Error('StageRun quality rubric refs are required.');
  }
  if (
    !Array.isArray(input.declared_stage_ids)
    || input.declared_stage_ids.length === 0
    || !input.declared_stage_ids.includes(input.stage_id)
  ) {
    throw new Error('StageRun route transport requires declared Stage ids including the current Stage.');
  }
  if (input.stage_role === 'cross_stage_meta_review' && input.quality_policy.formal_review.required) {
    throw new Error('Cross-stage Meta Review Stage cannot recursively require formal Stage Review.');
  }
  const recovery = input.recovery_resume;
  if (recovery) {
    const resumeAfterRole = recovery.resume_after_role ?? 'producer';
    const artifactProducer = recovery.artifact_producer_attempt_summary
      ?? recovery.producer_attempt_summary;
    const artifactProducerAttemptRef = recovery.artifact_producer_attempt_ref
      ?? recovery.producer_attempt_ref;
    const artifactIdentityMatches = JSON.stringify({
      artifact_refs: recovery.artifact_refs,
      artifact_hashes: recovery.artifact_hashes,
      artifact_identity_receipt_refs: recovery.artifact_identity_receipt_refs,
    }) === JSON.stringify({
      artifact_refs: artifactProducer?.artifact_refs,
      artifact_hashes: artifactProducer?.artifact_hashes,
      artifact_identity_receipt_refs: artifactProducer?.artifact_identity_receipt_refs,
    });
    if (
      recovery.surface_kind !== 'opl_stage_run_recovery_resume'
      || recovery.version !== 'opl-stage-run-recovery-resume.v1'
      || !recovery.recovery_id?.trim()
      || recovery.quality_cycle_id !== stageRunQualityCycleId(input)
      || !input.quality_policy.formal_review.required
      || artifactProducer?.attempt_role !== (resumeAfterRole === 'reviewer' ? 'producer' : resumeAfterRole)
      || !['producer', 'repairer', 'reviewer'].includes(resumeAfterRole)
      || artifactProducer.status !== 'completed'
      || !artifactProducer.stage_attempt_id?.trim()
      || !artifactProducer.workflow_id?.trim()
      || !artifactProducer.execution_session_ref?.trim()
      || artifactProducerAttemptRef !== `opl://stage_attempts/${artifactProducer.stage_attempt_id}`
      || recovery.artifact_refs.length === 0
      || recovery.artifact_refs.length !== recovery.artifact_hashes.length
      || recovery.artifact_refs.length !== recovery.artifact_identity_receipt_refs.length
      || !artifactIdentityMatches
    ) {
      throw new Error('StageRun recovery resume must bind one completed artifact producer and its exact artifact identity.');
    }
  }
}

export function stageRunStopped(state: TemporalStageRunWorkflowState) {
  return ['completed_with_quality_debt', 'blocked', 'human_gate', 'failed'].includes(state.status);
}

export function hasConsumableArtifact(state: TemporalStageRunWorkflowState) {
  return state.artifact_refs.length > 0
    && state.artifact_refs.length === state.artifact_hashes.length;
}

export function hasProducedConsumableArtifact(state: TemporalStageRunWorkflowState) {
  return state.attempts.some((attempt) => (
    (attempt.attempt_role === 'producer' || attempt.attempt_role === 'repairer')
    && attempt.artifact_refs.length > 0
    && attempt.artifact_refs.length === attempt.artifact_hashes.length
    && attempt.artifact_refs.length === attempt.artifact_identity_receipt_refs.length
  ));
}

export function qualityFailureRef(input: TemporalStageRunWorkflowInput, reason: string) {
  return `opl://stage-runs/${encodeURIComponent(input.stage_run_id)}/quality-debt/${encodeURIComponent(reason)}`;
}

export function activityFailureReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? activityFailureReason(error.cause) : error.message;
}

export function providerRuntimeHardStop(state: TemporalStageAttemptWorkflowState): {
  hard_stop_class: StageQualityHardStopClass;
  blocked_reason: string;
  typed_blocker_refs: string[];
  human_gate_refs: string[];
} | null {
  const closeout = asRecord(state.closeout_packet);
  const authorityBoundary = asRecord(closeout.authority_boundary);
  const isRuntimeBlocker = closeout.activity_status === 'blocked'
    && authorityBoundary.provider_runtime_blocker_ref_only === true
    && asRecordList(closeout.rejected_writes).some(
      (entry) => entry.surface_kind === 'opl_provider_runtime_typed_blocker_ref',
  );
  if (!isRuntimeBlocker) return null;
  const blockedReason = typeof closeout.blocked_reason === 'string' ? closeout.blocked_reason : '';
  const routeImpact = asRecord(closeout.route_impact);
  const declaredHardStopClass = routeImpact.hard_stop_class;
  const hardStopClass = typeof declaredHardStopClass === 'string'
    && STAGE_QUALITY_HARD_STOP_CLASSES.includes(declaredHardStopClass as StageQualityHardStopClass)
    ? declaredHardStopClass as StageQualityHardStopClass
    : null;
  const typedBlockerRefs = asRecordList(closeout.rejected_writes)
    .map((entry) => entry.blocker_ref)
    .filter((entry): entry is string => typeof entry === 'string' && Boolean(entry));
  return hardStopClass
    ? {
        hard_stop_class: hardStopClass,
        blocked_reason: blockedReason || 'stage_quality_provider_runtime_hard_stop',
        typed_blocker_refs: typedBlockerRefs,
        human_gate_refs: asStringList(state.human_gate_refs),
      }
    : null;
}

export function controllerHardStopFromError(error: unknown): {
  hardStopClass: StageQualityHardStopClass;
  blockedReason: string;
  typedBlockerRefs: string[];
  humanGateRefs: string[];
  sourceAttemptRef: string | null;
} | null {
  if (!(error instanceof FrameworkContractError)) return null;
  const hardStopClass = error.details?.hard_stop_class;
  const blockedReason = error.details?.blocked_reason;
  return typeof hardStopClass === 'string'
    && STAGE_QUALITY_HARD_STOP_CLASSES.includes(hardStopClass as StageQualityHardStopClass)
    && typeof blockedReason === 'string'
    ? {
        hardStopClass: hardStopClass as StageQualityHardStopClass,
        blockedReason,
        typedBlockerRefs: asStringList(error.details?.typed_blocker_refs),
        humanGateRefs: asStringList(error.details?.human_gate_refs),
        sourceAttemptRef: typeof error.details?.source_attempt_ref === 'string'
          ? error.details.source_attempt_ref
          : null,
      }
    : null;
}
