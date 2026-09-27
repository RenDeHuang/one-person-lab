import { proxyActivities } from '@temporalio/workflow';

import type {
  TemporalStageAttemptWorkflowInput,
  TemporalSchedulerTickWorkflowInput,
  TemporalStageQualityCycleProjectionInput,
  TemporalStageQualityAttemptSyncInput,
  TemporalStageQualityReviewReceiptInput,
  TemporalStageRunRouteLaunchInput,
  TemporalStageRunRouteLaunchReceipt,
  TemporalStageQualityAttemptMaterializationInput,
} from './family-runtime-temporal.ts';
import type { StageReviewReceipt } from '../../authority/stages/public/stage-quality-cycle.ts';
import {
  CODEX_STAGE_ACTIVITY_HEARTBEAT_TIMEOUT,
  CODEX_STAGE_ACTIVITY_START_TO_CLOSE_TIMEOUT,
  SHORT_STAGE_ACTIVITY_HEARTBEAT_TIMEOUT,
  SHORT_STAGE_ACTIVITY_SCHEDULE_TO_CLOSE_TIMEOUT,
  SHORT_STAGE_ACTIVITY_START_TO_CLOSE_TIMEOUT,
} from './family-runtime-temporal-constants.ts';

export type StageAttemptActivities = {
  codexStageActivity(input: TemporalStageAttemptWorkflowInput): Promise<Record<string, unknown>>;
  domainHandlerDispatchActivity(input: TemporalStageAttemptWorkflowInput): Promise<Record<string, unknown>>;
  schedulerTickActivity(input: TemporalSchedulerTickWorkflowInput): Promise<Record<string, unknown>>;
  stageQualityAttemptMaterializeActivity(
    input: TemporalStageQualityAttemptMaterializationInput,
  ): Promise<{
    attempt_ref: string;
    workflow_input: TemporalStageAttemptWorkflowInput;
  }>;
  stageQualityCycleProjectActivity(
    input: TemporalStageQualityCycleProjectionInput,
  ): Promise<Record<string, unknown>>;
  stageQualityAttemptSyncActivity(
    input: TemporalStageQualityAttemptSyncInput,
  ): Promise<Record<string, unknown> | null>;
  stageQualityReviewReceiptActivity(
    input: TemporalStageQualityReviewReceiptInput,
  ): Promise<StageReviewReceipt>;
  stageRunRouteLaunchActivity(
    input: TemporalStageRunRouteLaunchInput,
  ): Promise<TemporalStageRunRouteLaunchReceipt>;
};

export const { codexStageActivity } = proxyActivities<Pick<StageAttemptActivities, 'codexStageActivity'>>({
  startToCloseTimeout: CODEX_STAGE_ACTIVITY_START_TO_CLOSE_TIMEOUT,
  heartbeatTimeout: CODEX_STAGE_ACTIVITY_HEARTBEAT_TIMEOUT,
  retry: {
    maximumAttempts: 1,
  },
});

export const { domainHandlerDispatchActivity } = proxyActivities<Pick<StageAttemptActivities, 'domainHandlerDispatchActivity'>>({
  scheduleToCloseTimeout: SHORT_STAGE_ACTIVITY_SCHEDULE_TO_CLOSE_TIMEOUT,
  startToCloseTimeout: SHORT_STAGE_ACTIVITY_START_TO_CLOSE_TIMEOUT,
  heartbeatTimeout: SHORT_STAGE_ACTIVITY_HEARTBEAT_TIMEOUT,
  retry: {
    maximumAttempts: 3,
  },
});

export const { schedulerTickActivity } = proxyActivities<Pick<StageAttemptActivities, 'schedulerTickActivity'>>({
  scheduleToCloseTimeout: SHORT_STAGE_ACTIVITY_SCHEDULE_TO_CLOSE_TIMEOUT,
  startToCloseTimeout: SHORT_STAGE_ACTIVITY_START_TO_CLOSE_TIMEOUT,
  heartbeatTimeout: SHORT_STAGE_ACTIVITY_HEARTBEAT_TIMEOUT,
  retry: {
    maximumAttempts: 3,
  },
});

export const {
  stageQualityAttemptMaterializeActivity,
  stageQualityAttemptSyncActivity,
  stageQualityCycleProjectActivity,
  stageQualityReviewReceiptActivity,
  stageRunRouteLaunchActivity,
} = proxyActivities<Pick<
  StageAttemptActivities,
  | 'stageQualityAttemptMaterializeActivity'
  | 'stageQualityAttemptSyncActivity'
  | 'stageQualityCycleProjectActivity'
  | 'stageQualityReviewReceiptActivity'
  | 'stageRunRouteLaunchActivity'
>>({
  startToCloseTimeout: SHORT_STAGE_ACTIVITY_START_TO_CLOSE_TIMEOUT,
  retry: {
    maximumAttempts: 3,
  },
});

export const { stageRunRouteLaunchActivity: retryStageRunRouteLaunchActivity } = proxyActivities<
  Pick<StageAttemptActivities, 'stageRunRouteLaunchActivity'>
>({
  startToCloseTimeout: SHORT_STAGE_ACTIVITY_START_TO_CLOSE_TIMEOUT,
  retry: {
    maximumInterval: '30 seconds',
    nonRetryableErrorTypes: ['FrameworkContractError'],
  },
});
