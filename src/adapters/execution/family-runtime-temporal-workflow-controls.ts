import {
  defineQuery,
  defineSignal,
  defineUpdate,
} from '@temporalio/workflow';

import type {
  TemporalStageAttemptOperatorUpdateReceipt,
  TemporalStageAttemptSignalPayload,
  TemporalStageAttemptWorkflowState,
  TemporalStageRunWorkflowState,
  TemporalSchedulerTickWorkflowState,
} from './family-runtime-temporal.ts';

export const stageAttemptQuery = defineQuery<TemporalStageAttemptWorkflowState>('StageAttemptQuery');
export const stageRunQuery = defineQuery<TemporalStageRunWorkflowState>('StageRunQuery');
export const schedulerTickQuery = defineQuery<TemporalSchedulerTickWorkflowState>('SchedulerTickQuery');
export const humanGateSignal = defineSignal<[TemporalStageAttemptSignalPayload]>('HumanGateSignal');
export const ownerReceiptSignal = defineSignal<[TemporalStageAttemptSignalPayload]>('OwnerReceiptSignal');
export const userInstructionSignal = defineSignal<[TemporalStageAttemptSignalPayload]>('UserInstructionSignal');
export const resumeSignal = defineSignal<[TemporalStageAttemptSignalPayload]>('ResumeSignal');
export const stageAttemptOperatorUpdate = defineUpdate<
  TemporalStageAttemptOperatorUpdateReceipt,
  [TemporalStageAttemptSignalPayload]
>('StageAttemptOperatorUpdate');
