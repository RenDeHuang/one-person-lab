import { parseJsonText } from '../../../kernel/json-file.ts';
import type { RuntimeExecutionIdentityState, RuntimeExecutionScopeKind } from '../family-runtime-execution-scope-persistence.ts';
import type { TemporalStageRunWorkflowInput } from '../family-runtime-temporal.ts';

export type StageRunLaunchStatus = 'registered' | 'starting' | 'start_failed' | 'started' | 'closed';

export const DEFAULT_STAGE_RUN_START_LEASE_MS = 30_000;

export type StageRunLaunchRow = {
  stage_run_id: string;
  stage_run_invocation_id: string;
  stage_run_spec_sha256: string;
  domain_id: string;
  stage_id: string;
  workflow_id: string;
  parent_route_decision_ref: string | null;
  scope_kind?: RuntimeExecutionScopeKind;
  project_scope_id?: string | null;
  work_item_scope_id?: string | null;
  workspace_binding_id?: string | null;
  binding_version_id?: string | null;
  scope_digest?: string | null;
  execution_scope_json?: string | null;
  identity_state?: RuntimeExecutionIdentityState;
  stage_run_input_json: string;
  launch_status: StageRunLaunchStatus;
  temporal_start_receipt_json: string | null;
  terminal_status: string | null;
  last_start_error: string | null;
  start_claim_token: string | null;
  start_claimed_at: string | null;
  start_lease_expires_at: string | null;
  start_attempt_count: number;
  created_at: string;
  updated_at: string;
};

export type StageRunRecoveryRun = {
  surface_kind: 'opl_stage_run_recovery_run';
  version: 'opl-stage-run-recovery-run.v1';
  recovery_id: string;
  recovery_resume_sha256: string;
  quality_cycle_id: string;
  producer_attempt_ref: string;
  recovery_resume: NonNullable<TemporalStageRunWorkflowInput['recovery_resume']>;
  start_status: 'starting' | 'started' | 'start_failed';
  start_claim_token: string | null;
  start_claimed_at: string | null;
  start_lease_expires_at: string | null;
  start_attempt_count: number;
  temporal_start_receipt: Record<string, unknown> | null;
  temporal_start_receipt_history?: Record<string, unknown>[];
  last_start_error: string | null;
  created_at: string;
  updated_at: string;
};

export type StageRunRecoveryTerminalRetry = {
  recoveryRunId: string;
  workflowStatus: string;
  observationReceipt?: Record<string, unknown>;
};

export function parseObject(value: string | null) {
  if (!value) return null;
  const parsed = parseJsonText(value);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}
