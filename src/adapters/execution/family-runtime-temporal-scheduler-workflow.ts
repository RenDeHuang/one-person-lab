import { setHandler } from '@temporalio/workflow';
import type { TemporalSchedulerTickWorkflowInput, TemporalSchedulerTickWorkflowState } from './family-runtime-temporal.ts';
import { schedulerTickQuery } from './family-runtime-temporal-workflow-controls.ts';
import { schedulerTickActivity } from './family-runtime-temporal-workflow-activities.ts';
import { nowIso } from './family-runtime-temporal-workflow-shared.ts';

export async function SchedulerTickWorkflow(
  input: TemporalSchedulerTickWorkflowInput,
): Promise<TemporalSchedulerTickWorkflowState> {
  let state: TemporalSchedulerTickWorkflowState = {
    surface_kind: 'temporal_scheduler_tick_query',
    provider_kind: 'temporal',
    status: 'registered',
    tick_source: input.tick_source,
    started_at: nowIso(),
    updated_at: nowIso(),
    receipt: null,
    error: null,
    authority_boundary: {
      opl: 'scheduler_cadence_provider_slo_and_queue_projection_bridge',
      domain: 'truth_quality_artifact_gate_owner',
    },
  };
  setHandler(schedulerTickQuery, () => state);

  try {
    state = {
      ...state,
      status: 'running',
      updated_at: nowIso(),
    };
    const receipt = await schedulerTickActivity(input);
    state = {
      ...state,
      status: 'completed',
      updated_at: nowIso(),
      receipt,
    };
  } catch (error) {
    state = {
      ...state,
      status: 'failed',
      updated_at: nowIso(),
      error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }

  return state;
}
