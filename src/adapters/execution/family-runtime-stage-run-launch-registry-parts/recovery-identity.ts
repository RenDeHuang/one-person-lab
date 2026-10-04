import type { DatabaseSync } from 'node:sqlite';

import { canonicalJsonText } from '../../../kernel/canonical-json.ts';
import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import { getStageAttemptRow } from '../family-runtime-stage-attempt-ledger.ts';
import { normalizeReviewerInputSnapshotRequest } from '../family-runtime-reviewer-input-snapshot.ts';
import {
  requireTemporalStageRunWorkflowInputLaunchable,
  temporalStageRunRecoveryResumeSha256,
  type TemporalStageRunWorkflowInput,
} from '../family-runtime-temporal.ts';
import { parseObject, type StageRunLaunchRow, type StageRunRecoveryRun, type StageRunRecoveryTerminalRetry } from './types.ts';

export function recoveryRuns(receipt: Record<string, unknown>) {
  const value = receipt.recovery_runs;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Persisted StageRun recovery receipts are invalid.',
      { failure_code: 'stage_run_recovery_registry_invalid' },
    );
  }
  return value as StageRunRecoveryRun[];
}

function stageRunInputWithoutRecovery(input: TemporalStageRunWorkflowInput) {
  const { recovery_resume: _recoveryResume, ...baseInput } = input;
  return baseInput;
}

export function requireRecoveryRegistryIdentity(
  row: StageRunLaunchRow,
  workflowInput: TemporalStageRunWorkflowInput,
) {
  const launchInput = requireTemporalStageRunWorkflowInputLaunchable(workflowInput, {
    revalidateContent: 'historical_evidence',
  });
  const recovery = launchInput.recovery_resume!;
  const persistedInput = parseObject(row.stage_run_input_json);
  if (
    row.launch_status !== 'closed'
    || !persistedInput
    || canonicalJsonText(stageRunInputWithoutRecovery(launchInput)) !== canonicalJsonText(persistedInput)
  ) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'StageRun recovery must reuse one closed registered StageRun and its immutable launch input.',
      {
        failure_code: 'stage_run_recovery_launch_identity_mismatch',
        stage_run_id: row.stage_run_id,
        launch_status: row.launch_status,
      },
    );
  }
  return {
    recovery,
    recoveryResumeSha256: temporalStageRunRecoveryResumeSha256(launchInput),
  };
}

export function recoveryArtifactProducerAttemptRef(
  recovery: NonNullable<TemporalStageRunWorkflowInput['recovery_resume']>,
) {
  const ref = recovery.artifact_producer_attempt_ref ?? recovery.producer_attempt_ref;
  if (!ref) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'StageRun recovery registry requires the artifact-producing Attempt ref.',
      { failure_code: 'stage_run_recovery_producer_identity_mismatch' },
    );
  }
  return ref;
}

export function recoveryEntryIdentityMatches(
  entry: StageRunRecoveryRun,
  recovery: NonNullable<TemporalStageRunWorkflowInput['recovery_resume']>,
  recoveryResumeSha256: string,
) {
  return entry.recovery_id === recovery.recovery_id
    && entry.recovery_resume_sha256 === recoveryResumeSha256
    && entry.quality_cycle_id === recovery.quality_cycle_id
    && entry.producer_attempt_ref === recoveryArtifactProducerAttemptRef(recovery)
    && canonicalJsonText(entry.recovery_resume) === canonicalJsonText(recovery);
}

export function recoveryEntryCanAdvanceToRepairerResume(
  entry: StageRunRecoveryRun,
  recovery: NonNullable<TemporalStageRunWorkflowInput['recovery_resume']>,
  terminalRetry: StageRunRecoveryTerminalRetry,
) {
  const persistedRunId = typeof entry.temporal_start_receipt?.recovery_run_id === 'string'
    ? entry.temporal_start_receipt.recovery_run_id
    : null;
  const priorAttempts = recovery.prior_attempt_summaries;
  const priorProducerRef = entry.producer_attempt_ref;
  const priorProducerPresent = Array.isArray(priorAttempts)
    && priorAttempts.some((attempt) => `opl://stage_attempts/${attempt.stage_attempt_id}` === priorProducerRef);
  const nextProducerRef = recoveryArtifactProducerAttemptRef(recovery);
  const latestAttempt = Array.isArray(priorAttempts) ? priorAttempts.at(-1) : null;
  return entry.start_status === 'started'
    && persistedRunId === terminalRetry.recoveryRunId
    && terminalTemporalRecoveryStatus(terminalRetry.workflowStatus)
    && entry.quality_cycle_id === recovery.quality_cycle_id
    && priorProducerPresent
    && Array.isArray(recovery.findings)
    && recovery.findings.length > 0
    && Array.isArray(recovery.review_receipts)
    && recovery.review_receipts.length > 0
    && (
      (recovery.resume_after_role === 'repairer'
        && nextProducerRef !== priorProducerRef
        && latestAttempt?.attempt_role === 'repairer'
        && Array.isArray(recovery.repair_map)
        && recovery.repair_map.length > 0
        && recovery.repair_rounds_used === latestAttempt.quality_round_index)
      || (recovery.resume_after_role === 'reviewer'
        && nextProducerRef === priorProducerRef
        && latestAttempt?.attempt_role === 'reviewer'
        && recovery.reviewer_attempt_ref === `opl://stage_attempts/${latestAttempt.stage_attempt_id}`
        && recovery.review_receipts.at(-1)?.reviewer_attempt_ref === recovery.reviewer_attempt_ref
        && recovery.review_receipts.at(-1)?.producer_attempt_ref === priorProducerRef
        && recovery.review_receipts.at(-1)?.verdict === 'repair_required'
        && (recovery.repair_rounds_used ?? -1) >= (entry.recovery_resume.repair_rounds_used ?? 0)
        && canonicalJsonText(recovery.artifact_refs) === canonicalJsonText(entry.recovery_resume.artifact_refs)
        && canonicalJsonText(recovery.artifact_hashes) === canonicalJsonText(entry.recovery_resume.artifact_hashes)
        && canonicalJsonText(recovery.artifact_identity_receipt_refs) === canonicalJsonText(entry.recovery_resume.artifact_identity_receipt_refs))
    );
}

function recoveryResumeSnapshotEnrichmentIdentity(
  recovery: NonNullable<TemporalStageRunWorkflowInput['recovery_resume']>,
) {
  const {
    review_input_snapshot_materialization_request: _reviewerSnapshot,
    quality_debt_refs: _qualityDebtRefs,
    ...identity
  } = recovery;
  return identity;
}

function recoveryQualityDebtRefsCanAdvance(
  previous: NonNullable<TemporalStageRunWorkflowInput['recovery_resume']>,
  next: NonNullable<TemporalStageRunWorkflowInput['recovery_resume']>,
) {
  const previousRefs = previous.quality_debt_refs ?? [];
  const nextRefs = next.quality_debt_refs ?? [];
  return previousRefs.length <= nextRefs.length
    && previousRefs.every((ref, index) => nextRefs[index] === ref);
}

export function recoveryResumeChangedFields(
  previous: NonNullable<TemporalStageRunWorkflowInput['recovery_resume']>,
  next: NonNullable<TemporalStageRunWorkflowInput['recovery_resume']>,
) {
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .sort()
    .filter((field) => canonicalJsonText(previous[field as keyof typeof previous] ?? null)
      !== canonicalJsonText(next[field as keyof typeof next] ?? null));
}

export function recoveryEntryCanEnrichReviewerSnapshot(
  row: StageRunLaunchRow,
  entry: StageRunRecoveryRun,
  recovery: NonNullable<TemporalStageRunWorkflowInput['recovery_resume']>,
  terminalRetry: StageRunRecoveryTerminalRetry,
) {
  const previousSnapshot = entry.recovery_resume.review_input_snapshot_materialization_request;
  const nextSnapshot = recovery.review_input_snapshot_materialization_request;
  const persistedRunId = typeof entry.temporal_start_receipt?.recovery_run_id === 'string'
    ? entry.temporal_start_receipt.recovery_run_id
    : null;
  const observation = terminalRetry.observationReceipt;
  const terminalObservationMatchesFailedStart = entry.start_status === 'start_failed'
    && !persistedRunId
    && observation?.workflow_found === true
    && observation.stage_run_id === row.stage_run_id
    && observation.workflow_id === row.workflow_id
    && observation.recovery_id === entry.recovery_id
    && observation.first_execution_run_id === terminalRetry.recoveryRunId
    && observation.workflow_status === terminalRetry.workflowStatus;
  const persistedStartMatchesTerminalObservation = entry.start_status === 'started'
    && persistedRunId === terminalRetry.recoveryRunId;
  return entry.recovery_id === recovery.recovery_id
    && entry.quality_cycle_id === recovery.quality_cycle_id
    && entry.producer_attempt_ref === recoveryArtifactProducerAttemptRef(recovery)
    && (previousSnapshot === null || previousSnapshot === undefined)
    && Boolean(nextSnapshot && typeof nextSnapshot === 'object' && !Array.isArray(nextSnapshot))
    && canonicalJsonText(recoveryResumeSnapshotEnrichmentIdentity(entry.recovery_resume))
      === canonicalJsonText(recoveryResumeSnapshotEnrichmentIdentity(recovery))
    && recoveryQualityDebtRefsCanAdvance(entry.recovery_resume, recovery)
    && terminalTemporalRecoveryStatus(terminalRetry.workflowStatus)
    && (persistedStartMatchesTerminalObservation || terminalObservationMatchesFailedStart);
}

export function recoveryEntryCanExtendAcceptedProducerSnapshot(
  db: DatabaseSync,
  row: StageRunLaunchRow,
  entry: StageRunRecoveryRun,
  recovery: NonNullable<TemporalStageRunWorkflowInput['recovery_resume']>,
  terminalRetry: StageRunRecoveryTerminalRetry,
) {
  const previous = entry.recovery_resume;
  if (entry.start_status !== 'started'
    || entry.temporal_start_receipt?.recovery_run_id !== terminalRetry.recoveryRunId
    || !terminalTemporalRecoveryStatus(terminalRetry.workflowStatus)
    || previous.resume_after_role || recovery.resume_after_role
    || !previous.review_input_snapshot_materialization_request
    || !recovery.review_input_snapshot_materialization_request
    || entry.quality_cycle_id !== recovery.quality_cycle_id
    || entry.producer_attempt_ref !== recovery.producer_attempt_ref) return false;
  const before = normalizeReviewerInputSnapshotRequest(previous.review_input_snapshot_materialization_request);
  const after = normalizeReviewerInputSnapshotRequest(recovery.review_input_snapshot_materialization_request);

  const producer = getStageAttemptRow(db, entry.producer_attempt_ref.replace(/^opl:\/\/stage_attempts\//, ''));
  if (!producer || producer.stage_run_id !== row.stage_run_id
    || producer.attempt_role !== 'producer' || producer.status !== 'completed'
    || producer.closeout_receipt_status !== 'accepted_typed_closeout') return false;
  // Supplement only before review starts; never replace evidence already reviewed.
  if (db.prepare('SELECT 1 FROM stage_attempts WHERE stage_run_id = ? AND stage_attempt_id != ? LIMIT 1')
    .get(row.stage_run_id, producer.stage_attempt_id)) return false;
  const impact = parseObject(producer.route_impact_json);
  const quality = isRecord(impact?.stage_quality_cycle) ? impact.stage_quality_cycle : null;
  const hashes = (value: unknown) => Array.isArray(value)
    ? value.map((hash) => String(hash).replace(/^sha256:/, '')) : null;
  if (!quality
    || canonicalJsonText(quality.review_input_snapshot_materialization_request ?? null) !== canonicalJsonText(after)
    || canonicalJsonText(quality.artifact_refs ?? null) !== canonicalJsonText(recovery.artifact_refs)
    || canonicalJsonText(hashes(quality.artifact_hashes)) !== canonicalJsonText(hashes(recovery.artifact_hashes))
    || canonicalJsonText(quality.artifact_identity_receipt_refs ?? null) !== canonicalJsonText(recovery.artifact_identity_receipt_refs)) return false;

  const withoutArtifactLists = (value: Record<string, unknown>) => {
    const { artifact_refs: _refs, artifact_hashes: _hashes, artifact_identity_receipt_refs: _receipts, ...rest } = value;
    return rest;
  };
  const identity = (value: typeof recovery) => {
    const { recovery_id: _id, review_input_snapshot_materialization_request: _snapshot,
      producer_attempt_summary: summary, ...rest } = value;
    return { ...withoutArtifactLists(rest), producer_attempt_summary: summary ? withoutArtifactLists(summary) : null };
  };
  const snapshotIdentity = (value: typeof before) => {
    const { owner_authority_ref: _authority, members: _members, ...rest } = value;
    return rest;
  };
  return canonicalJsonText(identity(previous)) === canonicalJsonText(identity(recovery))
    && canonicalJsonText(snapshotIdentity(before)) === canonicalJsonText(snapshotIdentity(after))
    && previous.artifact_refs.every((ref, index) => {
      const nextIndex = recovery.artifact_refs.indexOf(ref);
      return nextIndex >= 0 && previous.artifact_hashes[index] === recovery.artifact_hashes[nextIndex]
        && previous.artifact_identity_receipt_refs[index] === recovery.artifact_identity_receipt_refs[nextIndex];
    })
    && before.members.every((member) => after.members.some((next) => next.source_ref === member.source_ref
      && next.sha256 === member.sha256 && next.size_bytes === member.size_bytes));
}

export function recoveryEntryCanRestoreOwnerRepairMap(
  db: DatabaseSync,
  row: StageRunLaunchRow,
  entry: StageRunRecoveryRun,
  recovery: NonNullable<TemporalStageRunWorkflowInput['recovery_resume']>,
  terminalRetry: StageRunRecoveryTerminalRetry,
) {
  if (entry.start_status !== 'started'
    || entry.temporal_start_receipt?.recovery_run_id !== terminalRetry.recoveryRunId
    || !terminalTemporalRecoveryStatus(terminalRetry.workflowStatus)
    || recovery.resume_after_role !== 'repairer'
    || canonicalJsonText(recoveryResumeChangedFields(entry.recovery_resume, recovery))
      !== canonicalJsonText(['repair_map'])) return false;
  const producerRef = recoveryArtifactProducerAttemptRef(recovery);
  const producer = getStageAttemptRow(db, producerRef.replace(/^opl:\/\/stage_attempts\//, ''));
  if (!producer || producer.stage_run_id !== row.stage_run_id
    || producer.attempt_role !== 'repairer') return false;
  const impact = parseObject(producer.route_impact_json);
  const quality = isRecord(impact?.stage_quality_cycle) ? impact.stage_quality_cycle : null;
  // A terminal recovery can correct only its derived map, never the owner's output.
  return Array.isArray(quality?.repair_map) && quality.repair_map.length > 0
    && canonicalJsonText(quality.repair_map) === canonicalJsonText(recovery.repair_map);
}

export function recoveryEntryCanAppendQualityDebtRefs(
  entry: StageRunRecoveryRun,
  recovery: NonNullable<TemporalStageRunWorkflowInput['recovery_resume']>,
  terminalRetry: StageRunRecoveryTerminalRetry,
) {
  return entry.start_status === 'started'
    && entry.temporal_start_receipt?.recovery_run_id === terminalRetry.recoveryRunId
    && terminalTemporalRecoveryStatus(terminalRetry.workflowStatus)
    && entry.recovery_id === recovery.recovery_id
    && entry.quality_cycle_id === recovery.quality_cycle_id
    && entry.producer_attempt_ref === recoveryArtifactProducerAttemptRef(recovery)
    && canonicalJsonText(recoveryResumeChangedFields(entry.recovery_resume, recovery))
      === canonicalJsonText(['quality_debt_refs'])
    && (recovery.quality_debt_refs?.length ?? 0) > (entry.recovery_resume.quality_debt_refs?.length ?? 0)
    && recoveryQualityDebtRefsCanAdvance(entry.recovery_resume, recovery);
}

export function terminalTemporalRecoveryStatus(value: string) {
  return [
    'COMPLETED',
    'FAILED',
    'CANCELED',
    'CANCELLED',
    'TERMINATED',
    'TIMED_OUT',
  ].includes(value.trim().toUpperCase());
}
