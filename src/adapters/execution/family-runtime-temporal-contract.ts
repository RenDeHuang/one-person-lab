import type { FamilyRuntimeDomainProfiles } from './family-runtime-command.ts';
import type { FamilyRuntimeDomainId, TemporalStageAttemptSignalKind } from './family-runtime-types.ts';
import {
  CODEX_STAGE_ACTIVITY_HEARTBEAT_TIMEOUT,
  CODEX_STAGE_ACTIVITY_START_TO_CLOSE_TIMEOUT,
  DEFAULT_CODEX_STAGE_ACTIVITY_HEARTBEAT_INTERVAL_MS,
  DEFAULT_CODEX_STAGE_RUNNER_NO_OUTPUT_TIMEOUT_MS,
  DEFAULT_CODEX_STAGE_RUNNER_TIMEOUT_MS,
  SHORT_STAGE_ACTIVITY_HEARTBEAT_TIMEOUT,
  SHORT_STAGE_ACTIVITY_SCHEDULE_TO_CLOSE_TIMEOUT,
  SHORT_STAGE_ACTIVITY_START_TO_CLOSE_TIMEOUT,
  SCHEDULER_TICK_WORKFLOW_RUN_TIMEOUT,
} from './family-runtime-temporal-constants.ts';
import type {
  FamilyRuntimeExecutionScopeKind,
  WorkItemExecutionScopeSnapshot,
} from './family-runtime-execution-scope.ts';

export const STAGE_ATTEMPT_WORKFLOW_NAME = 'StageAttemptWorkflow';
export const SCHEDULER_TICK_WORKFLOW_NAME = 'SchedulerTickWorkflow';
export const CODEX_STAGE_ACTIVITY_NAME = 'CodexStageActivity';
export const DOMAIN_HANDLER_DISPATCH_ACTIVITY_NAME = 'DomainHandlerDispatchActivity';
export const SCHEDULER_TICK_ACTIVITY_NAME = 'SchedulerTickActivity';
export const STAGE_RUN_WORKFLOW_NAME = 'StageRunWorkflow';
export const STAGE_ATTEMPT_ACTIVITY_NAME = 'StageAttemptActivity';
export const RECONCILE_WORKFLOW_NAME = 'ReconcileWorkflow';
export const HUMAN_GATE_SIGNAL_NAME = 'HumanGateSignal';
export const OWNER_RECEIPT_SIGNAL_NAME = 'OwnerReceiptSignal';
export const DEFAULT_TEMPORAL_TASK_QUEUE = 'opl-stage-attempts';
export const TEMPORAL_MAX_INLINE_PAYLOAD_BYTES = 128 * 1024;

export const TEMPORAL_STAGE_ATTEMPT_SEARCH_ATTRIBUTE_NAMES = [
  'OplStageAttemptId',
  'OplStageRunId',
  'OplWorkItemScopeId',
] as const;

export const TEMPORAL_STAGE_ATTEMPT_SIGNALS = [
  HUMAN_GATE_SIGNAL_NAME,
  OWNER_RECEIPT_SIGNAL_NAME,
  'UserInstructionSignal',
  'ResumeSignal',
] as const;

export const TEMPORAL_STAGE_ATTEMPT_QUERIES = [
  'StageAttemptQuery',
] as const;

export const TEMPORAL_STAGE_ATTEMPT_UPDATES = [
  'StageAttemptOperatorUpdate',
] as const;

export type { TemporalStageAttemptSignalKind } from './family-runtime-types.ts';

export {
  DEFAULT_CODEX_STAGE_RUNNER_NO_OUTPUT_TIMEOUT_MS,
  DEFAULT_CODEX_STAGE_RUNNER_TIMEOUT_MS,
  SCHEDULER_TICK_WORKFLOW_RUN_TIMEOUT,
};

export type TemporalStageAttemptSignalPayload = {
  signal_kind: TemporalStageAttemptSignalKind;
  payload: Record<string, unknown>;
  source?: string;
  received_at?: string;
};

export type TemporalStageAttemptOperatorUpdateReceipt = {
  surface_kind: 'temporal_stage_attempt_operator_update_receipt';
  provider_kind: 'temporal';
  update_status: 'accepted';
  stage_attempt_id: string;
  stage_run_id?: string | null;
  workflow_id: string;
  scope_kind?: FamilyRuntimeExecutionScopeKind;
  execution_scope?: WorkItemExecutionScopeSnapshot | null;
  signal_kind: TemporalStageAttemptSignalKind;
  signal_count: number;
  updated_at: string;
  authority_boundary: {
    opl: 'temporal_update_ack_and_transport_metadata_only';
    domain: 'truth_quality_artifact_gate_owner';
    provider_completion_is_domain_ready: false;
  };
};

export type TemporalStageAttemptWorkflowState = {
  surface_kind: 'temporal_stage_attempt_query';
  provider_kind: 'temporal';
  stage_attempt_id: string;
  stage_run_id?: string | null;
  workflow_id: string;
  scope_kind?: FamilyRuntimeExecutionScopeKind;
  execution_scope?: WorkItemExecutionScopeSnapshot | null;
  domain_id: FamilyRuntimeDomainId;
  stage_id: string;
  status: 'registered' | 'running' | 'checkpointed' | 'blocked' | 'human_gate' | 'completed' | 'failed';
  started_at: string;
  updated_at: string;
  activity_events: Array<Record<string, unknown>>;
  stage_progress_log: {
    surface_kind: 'temporal_workflow_stage_progress_log';
    planned_work: Record<string, unknown>;
    timeline: Array<Record<string, unknown>>;
    visibility: Record<string, unknown>;
  };
  checkpoint_refs: string[];
  closeout_refs: string[];
  consumed_refs: string[];
  consumed_memory_refs: string[];
  writeback_receipt_refs: string[];
  rejected_writes: Array<Record<string, unknown>>;
  next_owner: string | null;
  route_impact: Record<string, unknown>;
  human_gate_refs: string[];
  owner_receipt_refs?: string[];
  signals: TemporalStageAttemptSignalPayload[];
  closeout_packet: Record<string, unknown> | null;
  completion_boundary: {
    provider_completion: 'completed' | 'not_completed';
    domain_ready_verdict: string | null;
    provider_completion_is_domain_ready: false;
  };
  authority_boundary: {
    opl: 'temporal_workflow_transport_and_control_metadata_only';
    domain: 'truth_quality_artifact_gate_owner';
  };
};

export type TemporalSchedulerTickWorkflowInput = {
  provider_kind: 'temporal';
  tick_source: string;
  force?: boolean;
  limit?: number;
  hydrate?: boolean;
  domain_profiles?: FamilyRuntimeDomainProfiles;
};

export type TemporalSchedulerTickWorkflowState = {
  surface_kind: 'temporal_scheduler_tick_query';
  provider_kind: 'temporal';
  status: 'registered' | 'running' | 'completed' | 'failed';
  tick_source: string;
  started_at: string;
  updated_at: string;
  receipt: Record<string, unknown> | null;
  error: string | null;
  authority_boundary: {
    opl: 'scheduler_cadence_provider_slo_and_queue_projection_bridge';
    domain: 'truth_quality_artifact_gate_owner';
  };
};

export function buildTemporalStageAttemptWorkflowContract<
  VisibilityContract,
  SearchAttribute extends { name: string; type: string; source: string },
>(
  visibilityContract: VisibilityContract,
  searchAttributes: ReadonlyArray<SearchAttribute>,
) {
  return {
    provider_kind: 'temporal',
    workflow_name: STAGE_ATTEMPT_WORKFLOW_NAME,
    stage_run_controller_workflow_name: STAGE_RUN_WORKFLOW_NAME,
    stage_attempt_child_workflow_name: STAGE_ATTEMPT_WORKFLOW_NAME,
    temporal_first_runtime_contract: buildTemporalFirstRuntimeContract(),
    scheduler_tick_workflow_name: SCHEDULER_TICK_WORKFLOW_NAME,
    activity_names: {
      codex_stage_activity: CODEX_STAGE_ACTIVITY_NAME,
      domain_handler_dispatch_activity: DOMAIN_HANDLER_DISPATCH_ACTIVITY_NAME,
      scheduler_tick_activity: SCHEDULER_TICK_ACTIVITY_NAME,
      stage_quality_attempt_materialize_activity: 'StageQualityAttemptMaterializeActivity',
      stage_quality_attempt_sync_activity: 'StageQualityAttemptSyncActivity',
      stage_quality_cycle_project_activity: 'StageQualityCycleProjectActivity',
      stage_quality_review_receipt_activity: 'StageQualityReviewReceiptActivity',
    },
    signals: [...TEMPORAL_STAGE_ATTEMPT_SIGNALS],
    queries: [...TEMPORAL_STAGE_ATTEMPT_QUERIES],
    required_search_attributes: [...TEMPORAL_STAGE_ATTEMPT_SEARCH_ATTRIBUTE_NAMES],
    operator_action_updates: [...TEMPORAL_STAGE_ATTEMPT_UPDATES],
    default_task_queue: DEFAULT_TEMPORAL_TASK_QUEUE,
    visibility_contract: visibilityContract,
    search_attributes: searchAttributes.map((attribute) => ({
      name: attribute.name,
      type: attribute.type,
      source: attribute.source,
    })),
    scheduler_tick_timeout_policy: {
      workflow_run_timeout: SCHEDULER_TICK_WORKFLOW_RUN_TIMEOUT,
      workflow_execution_timeout: SCHEDULER_TICK_WORKFLOW_RUN_TIMEOUT,
      stale_overlap_release_policy:
        'fail_scheduler_tick_workflow_when_worker_does_not_pick_up_workflow_or_activity',
    },
    provider_completion_boundary: {
      provider_completion: 'workflow/activity transport completed',
      domain_ready_verdict: 'read from domain-owned quality or gate surface',
      opl_forbidden_authority: [
        'domain_truth',
        'domain_quality_verdict',
        'canonical_artifact_write',
      ],
    },
    activity_timeout_policy: {
      codex_stage_activity: {
        start_to_close_timeout: CODEX_STAGE_ACTIVITY_START_TO_CLOSE_TIMEOUT,
        heartbeat_timeout: CODEX_STAGE_ACTIVITY_HEARTBEAT_TIMEOUT,
        heartbeat_interval_ms: DEFAULT_CODEX_STAGE_ACTIVITY_HEARTBEAT_INTERVAL_MS,
        cancellation_delivered_by_heartbeat: true,
        runner_timeout_ms: DEFAULT_CODEX_STAGE_RUNNER_TIMEOUT_MS,
        runner_no_output_timeout_ms: DEFAULT_CODEX_STAGE_RUNNER_NO_OUTPUT_TIMEOUT_MS,
        retry: {
          maximum_attempts: 1,
          reason: 'codex_cli_subprocess_must_not_be_duplicated_by_temporal_retry',
        },
      },
      short_stage_activities: {
        schedule_to_close_timeout: SHORT_STAGE_ACTIVITY_SCHEDULE_TO_CLOSE_TIMEOUT,
        start_to_close_timeout: SHORT_STAGE_ACTIVITY_START_TO_CLOSE_TIMEOUT,
        heartbeat_timeout: SHORT_STAGE_ACTIVITY_HEARTBEAT_TIMEOUT,
        retry: {
          maximum_attempts: 3,
          reason: 'short_idempotent_opl_projection_or_dispatch_activity_retry',
        },
        stale_schedule_release_policy:
          'fail_short_activity_when_worker_does_not_pick_up_scheduled_task',
      },
    },
    payload_history_policy: temporalPayloadHistoryPolicy(),
  };
}

export function buildTemporalFirstRuntimeContract() {
  return {
    surface_kind: 'opl_temporal_first_runtime_contract',
    contract_id: 'opl_family_runtime_temporal_first_contract',
    contract_ref: 'contracts/opl-framework/family-runtime-temporal-first-contract.json',
    provider_kind: 'temporal',
    production_substrate: 'temporal_required_for_live_workflow_execution',
    readback_policy: 'contract_projection_only_no_live_temporal_service_started',
    workflow_activity_signal_mapping: {
      stage_run_workflow: {
        contract_name: STAGE_RUN_WORKFLOW_NAME,
        temporal_kind: 'workflow',
        current_workflow_type: STAGE_RUN_WORKFLOW_NAME,
        child_workflow_type: STAGE_ATTEMPT_WORKFLOW_NAME,
        role: 'non_model_durable_stage_run_controller_for_bounded_quality_attempts',
        task_queue: 'domain_runtime_lane_task_queue',
        event_history_role: 'durable_quality_loop_attempt_lineage_budget_and_terminalization_history',
        sqlite_role: 'projection_audit_cache_not_durable_lifecycle_truth',
      },
      stage_attempt_workflow: {
        contract_name: STAGE_ATTEMPT_WORKFLOW_NAME,
        temporal_kind: 'child_workflow',
        parent_workflow_type: STAGE_RUN_WORKFLOW_NAME,
        role: 'one_context_isolated_executor_invocation_for_a_framework_bounded_attempt_role',
        may_create_authoritative_attempts: false,
        may_transition_stage: false,
      },
      stage_attempt_activity: {
        contract_name: STAGE_ATTEMPT_ACTIVITY_NAME,
        temporal_kind: 'activity',
        current_activity_types: [
          CODEX_STAGE_ACTIVITY_NAME,
          DOMAIN_HANDLER_DISPATCH_ACTIVITY_NAME,
        ],
        role: 'execute_codex_or_domain_handler_attempt_and_return_refs_only_closeout_transport',
        retry_policy_owner: 'temporal_activity_retry_policy',
        dead_letter_role: 'temporal_failure_history_plus_opl_operator_projection_only',
      },
      reconcile_workflow: {
        contract_name: RECONCILE_WORKFLOW_NAME,
        temporal_kind: 'workflow',
        current_workflow_type: SCHEDULER_TICK_WORKFLOW_NAME,
        current_activity_type: SCHEDULER_TICK_ACTIVITY_NAME,
        role: 'scheduled_desired_current_reconciliation_and_next_safe_action_projection',
        schedule_id: 'opl-family-runtime-provider-scheduler',
        scheduler_role: 'trigger_reconcile_cadence_only_not_domain_terminal_state_writer',
      },
      human_gate_signal: {
        contract_name: HUMAN_GATE_SIGNAL_NAME,
        temporal_kind: 'signal',
        signal_kind: 'human_gate',
        role: 'append_human_gate_ref_to_workflow_history_and_projection',
        closes_stage: false,
      },
      owner_receipt_signal: {
        contract_name: OWNER_RECEIPT_SIGNAL_NAME,
        temporal_kind: 'signal',
        signal_kind: 'owner_receipt',
        role: 'append_domain_owner_receipt_ref_to_workflow_history_and_projection',
        owner_receipt_is_ref_only: true,
        opl_can_sign_owner_receipt: false,
        closes_stage_without_domain_authority: false,
      },
    },
    task_queue_mapping: {
      default_task_queue: DEFAULT_TEMPORAL_TASK_QUEUE,
      resolver: 'resolveTemporalWorkerTaskQueue(paths)',
      grouping_policy: 'family_runtime_root_and_domain_runtime_lane',
      priority_and_rate_policy: 'temporal_or_worker_level_policy_only_not_sqlite_queue_truth',
    },
    retry_mapping: {
      codex_stage_activity: {
        maximum_attempts: 1,
        reason: 'codex_cli_subprocess_must_not_be_duplicated_by_temporal_retry',
      },
      short_idempotent_activities: {
        maximum_attempts: 3,
        reason: 'projection_or_dispatch_activity_retry_owned_by_temporal',
      },
      opl_dead_letter_role: 'authority_ref_and_operator_projection_only',
    },
    schedule_mapping: {
      schedule_id: 'opl-family-runtime-provider-scheduler',
      workflow_type: SCHEDULER_TICK_WORKFLOW_NAME,
      target_contract_workflow: RECONCILE_WORKFLOW_NAME,
      cadence_owner: 'temporal_schedule',
      scheduler_may_enqueue_domain_work_directly: false,
      scheduler_may_write_terminal_state: false,
    },
    event_history_mapping: {
      temporal_history_is_durable_lifecycle_truth: true,
      required_history_refs: [
        'WorkflowExecutionStarted',
        'ActivityTaskScheduled',
        'ActivityTaskCompleted',
        'WorkflowExecutionSignaled',
        'WorkflowExecutionCompleted',
        'WorkflowExecutionFailed',
      ],
      sqlite_projection_only_fields: [
        'tasks.status',
        'stage_attempts.status',
        'stage_attempt_signals.payload_json',
      ],
      sqlite_sidecar_role: 'projection_and_readback_index_only_not_runtime_provider',
    },
    durable_lifecycle_readback: {
      command_surface: 'opl family-runtime attempt query <stage_attempt_id>',
      surface_kind: 'temporal_durable_lifecycle_readback',
      binds_identity: [
        'workflow_id',
        'run_id',
        'stage_attempt_id',
        'schedule_id',
        'task_queue',
      ],
      required_evidence: [
        'workflow_id',
        'temporal_workflow_history_or_query_readback',
        'stage_attempt_identity',
        'temporal_schedule_identity',
        'temporal_task_queue_identity',
        'authority_event_ref_or_projection_rebuild_ref',
      ],
      sqlite_status_role: 'projection_only_not_temporal_lifecycle_truth',
      ready_claim_allowed_without_temporal_history: false,
    },
    false_ready_boundary: {
      live_workflow_execution_ready_requires: [
        'temporal_service_reachable',
        'temporal_worker_ready',
        'scheduler_cadence_ready',
        'temporal_history_or_authority_projection_rebuilds_lifecycle',
      ],
      not_proven_by: [
        'contract_readback',
        'sqlite_projection_clean',
        'local_provider_pass',
        'focused_tests_pass',
        'provider_completion',
      ],
      forbidden_claims: [
        'production_ready',
        'domain_ready',
        'owner_acceptance',
        'provider_completion_is_domain_completion',
        'sqlite_queue_is_durable_lifecycle_truth',
      ],
    },
    authority_boundary: {
      can_write_domain_truth: false,
      can_sign_owner_receipt: false,
      can_create_typed_blocker: false,
      can_authorize_domain_ready: false,
      provider_completion_is_domain_ready: false,
    },
  } as const;
}

export function temporalPayloadHistoryPolicy() {
  return {
    max_inline_string_bytes: TEMPORAL_MAX_INLINE_PAYLOAD_BYTES,
    large_payload_storage: 'external_ref_required',
    large_payload_ref_prefix: 'payload_ref:sha256:',
    scheduler_tick_activity_result: {
      result_surface_kind: 'temporal_scheduler_tick_activity_receipt',
      max_inline_bytes: TEMPORAL_MAX_INLINE_PAYLOAD_BYTES,
      full_scheduler_tick_body_omitted: true,
      retained_summary_fields: [
        'provider_cadence_surface_kind',
        'scheduler_owner',
        'cadence_owner',
        'provider_kind',
        'cadence_source',
        'cadence_status',
        'task_scope',
        'provider_readiness_after_slo',
        'provider_liveness_blocker',
        'provider_blocker',
        'provider_slo_summary',
        'queue_projection_bridge',
        'retired_queue_tick',
        'authority_boundary',
      ],
      omitted_body_fields: [
        'provider_runtime',
        'provider_runtime_after_slo',
        'provider_slo',
        'task_scope.payloadMatches',
        'provider_readiness_after_slo.blockers',
        'provider_readiness_after_slo.repair_action.body',
        'provider_liveness_blocker.next_repair_action.body',
        'provider_blocker.next_repair_action.body',
        'queue_projection_bridge.body',
        'retired_queue_tick.dispatches',
      ],
      authority_boundary: {
        can_write_domain_truth: false,
        can_write_domain_memory_body: false,
        can_authorize_quality_verdict: false,
        can_authorize_export_verdict: false,
        provider_completion_is_domain_ready: false,
      },
    },
  } as const;
}
