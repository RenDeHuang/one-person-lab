import { FrameworkContractError, isRecord } from '../../kernel/contract-validation.ts';
import {
  type TemporalStageQualityAttemptSyncInput,
  type TemporalStageQualityReviewReceiptInput,
} from './family-runtime-temporal.ts';
import { openQueueDb } from './family-runtime-store.ts';
import {
  createStageAttemptTable,
  materializePersistedStageReviewReceipt,
  syncStageAttemptFromTemporalTerminalObservation,
} from './family-runtime-stage-attempts.ts';
import { getStageAttemptRow } from './family-runtime-stage-attempt-ledger.ts';
import { requireRuntimeExecutionScopeMutationAllowed } from './family-runtime-execution-scope-persistence.ts';
import {
  requirePersistedStageAttemptActivityIdentity,
  requireResolvedPersistedStageAttemptIdentity,
  requireSamePersistedStageRunAttemptIdentity,
} from './family-runtime-persisted-identity-admission.ts';
import { materializeOplRevisionTransport } from './family-runtime-revision-intake.ts';
import {
  persistReviewEvidenceArtifactCandidate,
  type ReviewEvidenceArtifactContext,
} from './family-runtime-review-evidence-artifact.ts';
import {
  exactRefsFromCloseoutMetadata,
  persistedJsonRecord,
  reviewerEvidenceArtifactContext,
  stageAttemptIdFromRef,
} from './family-runtime-temporal-activity-identity.ts';
export async function stageQualityAttemptSyncActivity(input: TemporalStageQualityAttemptSyncInput) {
  const { db } = openQueueDb();
  try {
    createStageAttemptTable(db);
    const stageAttemptId = stageAttemptIdFromRef(input.attempt_ref);
    const rawAttempt = getStageAttemptRow(db, stageAttemptId);
    if (!rawAttempt) {
      throw new FrameworkContractError('contract_shape_invalid', 'StageAttempt is not persisted.', {
        failure_code: 'persisted_runtime_stage_attempt_not_found',
        stage_attempt_id: stageAttemptId,
      });
    }
    requireRuntimeExecutionScopeMutationAllowed(
      db,
      rawAttempt as unknown as Record<string, unknown>,
      'temporal_stage_quality_attempt_sync_activity:raw_attempt',
    );
    requirePersistedStageAttemptActivityIdentity({
      db,
      candidateIdentity: input.workflow_state as unknown as Record<string, unknown>,
      stageAttemptId,
      operation: 'temporal_stage_quality_attempt_sync_activity',
    });
    const syncReceipt = syncStageAttemptFromTemporalTerminalObservation(db, {
      surface_kind: 'temporal_stage_attempt_query_receipt',
      provider_kind: 'temporal',
      stage_attempt_id: stageAttemptId,
      workflow_id: input.workflow_state.workflow_id,
      workflow_status: 'COMPLETED',
      query: input.workflow_state,
    });
    const closeout = isRecord(input.workflow_state.closeout_packet)
      ? input.workflow_state.closeout_packet
      : {};
    const routeImpact = isRecord(closeout.route_impact) ? closeout.route_impact : {};
    const envelope = isRecord(routeImpact.stage_quality_cycle)
      ? routeImpact.stage_quality_cycle
      : {};
    if (!Object.hasOwn(envelope, 'page_hash_evidence_candidate')) {
      return {
        ...(isRecord(syncReceipt) ? syncReceipt : {}),
        opl_review_evidence_artifact_receipt_ref: null,
        opl_review_evidence_artifact_receipt: null,
      };
    }
    const row = db.prepare(`
      SELECT attempt_role, quality_context_json
      FROM stage_attempts
      WHERE stage_attempt_id = ?
      LIMIT 1
    `).get(stageAttemptId) as {
      attempt_role?: string | null;
      quality_context_json?: string | null;
    } | undefined;
    if (!row || (row.attempt_role !== 'reviewer' && row.attempt_role !== 're_reviewer')) {
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'Review evidence artifact may only be persisted from a reviewer Attempt.',
        {
          failure_code: 'review_evidence_artifact_candidate_non_reviewer',
          stage_attempt_id: stageAttemptId,
          attempt_role: row?.attempt_role ?? null,
        },
      );
    }
    const qualityContext = persistedJsonRecord(
      row.quality_context_json,
      'review_evidence_artifact_quality_context_invalid',
    );
    const attemptRef = `opl://stage_attempts/${stageAttemptId}`;
    const artifactContext = reviewerEvidenceArtifactContext({
      attemptRef,
      qualityContext,
      closeout,
      producerPackageId: envelope.page_hash_evidence_candidate_package_id,
      originEvidenceRef: envelope.page_hash_evidence_origin_ref,
    });
    const persisted = persistReviewEvidenceArtifactCandidate(
      envelope.page_hash_evidence_candidate,
      artifactContext,
    );
    db.prepare(`
      UPDATE stage_attempts
      SET quality_context_json = ?, updated_at = ?
      WHERE stage_attempt_id = ?
    `).run(JSON.stringify({
      ...qualityContext,
      opl_review_evidence_artifact_receipt_ref: persisted.receipt_ref,
      opl_review_evidence_artifact_receipt: persisted.receipt,
    }), new Date().toISOString(), stageAttemptId);
    return {
      ...(isRecord(syncReceipt) ? syncReceipt : {}),
      opl_review_evidence_artifact_receipt_ref: persisted.receipt_ref,
      opl_review_evidence_artifact_receipt: persisted.receipt,
    };
  } finally {
    db.close();
  }
}
export async function stageQualityReviewReceiptActivity(input: TemporalStageQualityReviewReceiptInput) {
  const { db } = openQueueDb();
  try {
    createStageAttemptTable(db);
    const producerAttemptId = stageAttemptIdFromRef(input.producer_attempt_ref);
    const reviewerAttemptId = stageAttemptIdFromRef(input.reviewer_attempt_ref);
    for (const [stageAttemptId, operation] of [
      [producerAttemptId, 'temporal_stage_quality_review_receipt_activity:raw_producer'],
      [reviewerAttemptId, 'temporal_stage_quality_review_receipt_activity:raw_reviewer'],
    ] as const) {
      const row = getStageAttemptRow(db, stageAttemptId);
      if (!row) {
        throw new FrameworkContractError('contract_shape_invalid', 'StageAttempt is not persisted.', {
          failure_code: 'persisted_runtime_stage_attempt_not_found',
          stage_attempt_id: stageAttemptId,
        });
      }
      requireRuntimeExecutionScopeMutationAllowed(
        db,
        row as unknown as Record<string, unknown>,
        operation,
      );
    }
    const producer = requireResolvedPersistedStageAttemptIdentity({
      db,
      stageAttemptId: producerAttemptId,
      operation: 'temporal_stage_quality_review_receipt_activity:producer',
    });
    const reviewer = requireResolvedPersistedStageAttemptIdentity({
      db,
      stageAttemptId: reviewerAttemptId,
      operation: 'temporal_stage_quality_review_receipt_activity:reviewer',
    });
    requireSamePersistedStageRunAttemptIdentity({
      stageRunIdentity: producer as unknown as Record<string, unknown>,
      stageAttemptIdentity: reviewer as unknown as Record<string, unknown>,
      operation: 'temporal_stage_quality_review_receipt_activity:pair',
    });
    const receipt = materializePersistedStageReviewReceipt(db, {
      producerAttemptId,
      reviewerAttemptId,
      rubricRefs: input.rubric_refs,
      verdict: input.verdict,
    });
    return {
      ...receipt,
      revision_transport: materializeOplRevisionTransport(receipt),
    };
  } finally {
    db.close();
  }
}
