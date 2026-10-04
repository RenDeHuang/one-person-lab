import type {
  FamilyRuntimeDomainId,
  FamilyRuntimeProviderKind,
  TemporalStageAttemptSignalKind,
} from '../family-runtime-types.ts';
import type { FamilyRuntimeCommandInput } from '../family-runtime-command.ts';
import { assertDomainId, assertProviderKind, assertSignalKind, parseCliOptions, parsePayloadArg } from './shared.ts';

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadFrameworkContracts } from '../../../authority/contracts/index.ts';
import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import { canonicalJsonText } from '../../../kernel/canonical-json.ts';
import { parseJsonText } from '../../../kernel/json-file.ts';
import { preflightDomainWorkspaceCheckoutCurrentness } from '../family-runtime-checkout-currentness.ts';
import {
  ensureFamilyRuntimePackageLaunchReady,
  packageRuntimeSourceCheckoutPath,
} from '../family-runtime-package-readiness.ts';
import { resolveFamilyRuntimeProviderKind } from '../family-runtime-providers.ts';
import type {
  CordisPackStageBindingService,
  resolveStandardAgentStageQualityRuntimeBinding,
} from '../../../authority/packages/index.ts';
import {
  resolveStandardAgentStageReviewLane,
  stageAttemptExecutorPolicyWithReviewLane,
} from '../../../authority/packages/index.ts';
import type { CordisStagecraftContextService } from '../../../authority/stages/index.ts';
import { buildStageLaunchInvocationProjection } from '../family-runtime-launch-invocation.ts';
import { buildPackBoundTemporalStageRunInput } from '../family-runtime-pack-bound-stage-run.ts';
import {
  createStageAttempt,
  findIdempotentStageAttempt,
  inspectStageAttempt,
  inspectStageAttemptWithCurrentProviderReadiness,
  listStageAttemptsForTask,
  queryStageAttempt,
  runStageAttemptFixtureActivity,
  signalStageAttempt,
  syncStageAttemptFromTemporalTerminalObservation,
} from '../family-runtime-stage-attempts.ts';
import { listStageAttemptsWithMonitoringProjection } from '../family-runtime-stage-attempt-monitoring.ts';
import { markStageAttemptCancelRequested } from '../family-runtime-stage-attempt-control.ts';
import { setStageAttemptArchived } from '../family-runtime-stage-attempt-ledger.ts';
import { queryStageAttemptWithCurrentProviderReadiness } from '../family-runtime-stage-attempt-current-query.ts';
import {
  familyRuntimePaths,
  insertEvent,
  stableId,
} from '../family-runtime-store.ts';
import { readManagedProviderProjectionSummary } from '../family-runtime-managed-provider-projection.ts';
import { queryTemporalStageAttemptReadModel } from '../family-runtime-temporal-query.ts';
import { preflightFamilyRuntimeDomainLifecycleAdmission } from '../family-runtime-domain-lifecycle-admission.ts';
import { requireRuntimeExecutionScopeMutationAllowed } from '../family-runtime-execution-scope-persistence.ts';
import {
  attachCheckoutCurrentnessToStageContext,
  persistStageAttemptLaunchBinding,
  recordTemporalStartOnAttempt,
} from '../family-runtime-parts/stage-attempt-launch.ts';
import {
  buildCliStageRunInvocationId,
  deriveStageRunId,
  explicitStageRunInvocationId,
  stageRunWorkspaceIdentity,
} from '../family-runtime-stage-run-identity.ts';
import { canonicalStageRunSha256 } from '../family-runtime-stage-run-identity-parts/content-bindings.ts';
import { launchRegisteredStageRun } from '../family-runtime-stage-run-launch.ts';
import { findStageRunLaunch } from '../family-runtime-stage-run-launch-registry.ts';
import {
  bindTrustedCliFamilyRuntimeIngressIdentity,
  requireFamilyRuntimeExecutionScope,
} from '../family-runtime-execution-scope.ts';

export function parseAttemptArgs(rest: string[]): FamilyRuntimeCommandInput | undefined {
  if (rest[0] === 'list') {
    return parseAttemptListArgs(rest);
  }
  if (rest[0] === 'inspect') {
    const stageAttemptId = rest[1];
    if (!stageAttemptId || rest.length > 2) {
      throw new FrameworkContractError('cli_usage_error', 'family-runtime attempt inspect requires one attempt id.', {
        usage: 'opl family-runtime attempt inspect <stage_attempt_id>',
      });
    }
    return { mode: 'attempt_inspect', stageAttemptId };
  }
  if (rest[0] === 'start') {
    const stageAttemptId = rest[1];
    if (!stageAttemptId || rest.length > 2) {
      throw new FrameworkContractError('cli_usage_error', 'family-runtime attempt start requires one attempt id.', {
        usage: 'opl family-runtime attempt start <stage_attempt_id>',
      });
    }
    return { mode: 'attempt_start', stageAttemptId };
  }
  if (rest[0] === 'query') {
    const stageAttemptId = rest[1];
    if (!stageAttemptId || rest.length > 2) {
      throw new FrameworkContractError('cli_usage_error', 'family-runtime attempt query requires one attempt id.', {
        usage: 'opl family-runtime attempt query <stage_attempt_id>',
      });
    }
    return { mode: 'attempt_query', stageAttemptId };
  }
  if (rest[0] === 'cancel') {
    return parseAttemptCancelArgs(rest);
  }
  if (rest[0] === 'archive' || rest[0] === 'restore') {
    return parseAttemptArchiveArgs(rest);
  }
  if (rest[0] === 'signal') {
    return parseAttemptSignalArgs(rest);
  }
  if (rest[0] === 'fixture-run') {
    return parseAttemptFixtureRunArgs(rest);
  }
  if (rest[0] === 'create') {
    return parseAttemptCreateArgs(rest);
  }
  return undefined;
}

function parseAttemptArchiveArgs(rest: string[]): FamilyRuntimeCommandInput {
  const action = rest[0] as 'archive' | 'restore';
  const stageAttemptId = rest[1];
  if (!stageAttemptId) {
    throw new FrameworkContractError('cli_usage_error', `family-runtime attempt ${action} requires one attempt id.`, {
      usage: `opl family-runtime attempt ${action} <stage_attempt_id> [--reason <operator_reason>] [--source <source>]`,
    });
  }
  let reason = action === 'archive' ? 'operator_archived' : 'operator_restored';
  let source: string | undefined;
  parseCliOptions(rest, 2, (token, value) => {
    if (token === '--reason' && value) {
      reason = value;
      return true;
    }
    if (token === '--source' && value) {
      source = value;
      return true;
    }
    throw new FrameworkContractError('cli_usage_error', `Unknown family-runtime attempt ${action} option: ${token}.`, {
      option: token,
    });
  });
  return {
    mode: action === 'archive' ? 'attempt_archive' : 'attempt_restore',
    stageAttemptId,
    reason,
    source,
  };
}

function parseAttemptListArgs(rest: string[]): FamilyRuntimeCommandInput {
  let domainId: FamilyRuntimeDomainId | undefined;
  let status: string | undefined;
  let studyId: string | undefined;
  let sinceHours: number | undefined;
  let compactTimeline = false;
  let full = false;
  parseCliOptions(rest, 1, (token, value) => {
    if (token === '--domain' && value) {
      domainId = assertDomainId(value);
      return true;
    } else if (token === '--status' && value) {
      status = value.trim();
      return true;
    } else if (token === '--study' && value) {
      studyId = value.trim();
      return true;
    } else if (token === '--since-hours' && value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new FrameworkContractError('cli_usage_error', 'family-runtime attempt list --since-hours must be a positive number.', {
          option: '--since-hours',
          value,
        });
      }
      sinceHours = parsed;
      return true;
    } else if (token === '--compact-timeline') {
      compactTimeline = true;
      return false;
    } else if (token === '--full') {
      full = true;
      return false;
    } else {
      throw new FrameworkContractError('cli_usage_error', `Unknown family-runtime attempt list option: ${token}.`, {
        option: token,
        usage: 'opl family-runtime attempt list [--domain <domain>] [--status <status>] [--study <study_id>] [--since-hours <hours>] [--compact-timeline] [--full]',
      });
    }
  });
  if (compactTimeline && full) {
    throw new FrameworkContractError('cli_usage_error', 'family-runtime attempt list cannot combine --compact-timeline and --full.', {
      options: ['--compact-timeline', '--full'],
    });
  }
  return {
    mode: 'attempt_list',
    filters: {
      domainId,
      status,
      studyId,
      sinceHours,
      compactTimeline,
      full,
    },
  };
}

function parseAttemptCancelArgs(rest: string[]): FamilyRuntimeCommandInput {
  const stageAttemptId = rest[1];
  if (!stageAttemptId) {
    throw new FrameworkContractError('cli_usage_error', 'family-runtime attempt cancel requires one attempt id.', {
      usage: 'opl family-runtime attempt cancel <stage_attempt_id> --reason <operator_reason> [--source <source>]',
    });
  }
  let reason = '';
  let source: string | undefined;
  parseCliOptions(rest, 2, (token, value) => {
    if (token === '--reason' && value) {
      reason = value;
      return true;
    } else if (token === '--source' && value) {
      source = value;
      return true;
    } else {
      throw new FrameworkContractError('cli_usage_error', `Unknown family-runtime attempt cancel option: ${token}.`, {
        option: token,
      });
    }
  });
  if (!reason.trim()) {
    throw new FrameworkContractError('cli_usage_error', 'family-runtime attempt cancel requires --reason.', {
      usage: 'opl family-runtime attempt cancel <stage_attempt_id> --reason <operator_reason> [--source <source>]',
    });
  }
  return {
    mode: 'attempt_cancel',
    stageAttemptId,
    reason,
    source,
  };
}

function parseAttemptSignalArgs(rest: string[]): FamilyRuntimeCommandInput {
  const stageAttemptId = rest[1];
  if (!stageAttemptId) {
    throw new FrameworkContractError('cli_usage_error', 'family-runtime attempt signal requires one attempt id.', {
      usage: 'opl family-runtime attempt signal <stage_attempt_id> --kind human_gate|owner_receipt|user_instruction|resume --payload <json>',
    });
  }
  let signalKind: TemporalStageAttemptSignalKind | undefined;
  let payload: string | undefined;
  let payloadFile: string | undefined;
  let source: string | undefined;
  parseCliOptions(rest, 2, (token, value) => {
    if (token === '--kind' && value) {
      signalKind = assertSignalKind(value);
      return true;
    } else if (token === '--payload' && value) {
      payload = value;
      return true;
    } else if (token === '--payload-file' && value) {
      payloadFile = value;
      return true;
    } else if (token === '--source' && value) {
      source = value;
      return true;
    } else {
      throw new FrameworkContractError('cli_usage_error', `Unknown family-runtime attempt signal option: ${token}.`, {
        option: token,
      });
    }
  });
  if (!signalKind) {
    throw new FrameworkContractError('cli_usage_error', 'family-runtime attempt signal requires --kind.', {
      required: ['--kind'],
    });
  }
  return {
    mode: 'attempt_signal',
    stageAttemptId,
    signalKind,
    payload: parsePayloadArg(payload, payloadFile),
    source,
  };
}

function parseAttemptFixtureRunArgs(rest: string[]): FamilyRuntimeCommandInput {
  const stageAttemptId = rest[1];
  if (!stageAttemptId) {
    throw new FrameworkContractError('cli_usage_error', 'family-runtime attempt fixture-run requires one attempt id.', {
      usage: 'opl family-runtime attempt fixture-run <stage_attempt_id> [--closeout-packet <json>]',
    });
  }
  let stagePacketRef: string | undefined;
  let closeoutPacket: string | undefined;
  let closeoutPacketFile: string | undefined;
  const checkpointRefs: string[] = [];
  parseCliOptions(rest, 2, (token, value) => {
    if (token === '--stage-packet-ref' && value) {
      stagePacketRef = value;
      return true;
    } else if (token === '--checkpoint-ref' && value) {
      checkpointRefs.push(value);
      return true;
    } else if (token === '--closeout-packet' && value) {
      closeoutPacket = value;
      return true;
    } else if (token === '--closeout-packet-file' && value) {
      closeoutPacketFile = value;
      return true;
    } else {
      throw new FrameworkContractError('cli_usage_error', `Unknown family-runtime attempt fixture-run option: ${token}.`, {
        option: token,
      });
    }
  });
  return {
    mode: 'attempt_fixture_run',
    stageAttemptId,
    stagePacketRef,
    checkpointRefs,
    closeoutPacket:
      closeoutPacket || closeoutPacketFile
        ? parsePayloadArg(closeoutPacket, closeoutPacketFile)
        : undefined,
  };
}

function parseAttemptCreateArgs(rest: string[]): FamilyRuntimeCommandInput {
  let domainId: FamilyRuntimeDomainId | undefined;
  let stageId = '';
  let actionId: string | undefined;
  let providerKind: FamilyRuntimeProviderKind | undefined;
  let workspaceLocator: string | undefined;
  let workspaceLocatorFile: string | undefined;
  let scopeKind: 'work_item' | 'domain' | 'system' | undefined;
  let executionScope: string | undefined;
  let executionScopeFile: string | undefined;
  let retryBudget: string | undefined;
  let retryBudgetFile: string | undefined;
  let sourceFingerprint: string | undefined;
  let executorKind: string | undefined;
  let executorBindingRef: string | undefined;
  let invocationMode: 'invocation' | 'authoring' | undefined;
  let boundedEditRef: string | undefined;
  let reviewLane: string | undefined;
  let taskId: string | undefined;
  let blockedReason: string | undefined;
  let newStageRun = false;
  let stageRunInvocationId: string | undefined;
  let parentRouteDecisionRef: string | undefined;
  let start = false;
  const checkpointRefs: string[] = [];
  const inputArtifactRefs: string[] = [];
  const inputArtifactHashes: string[] = [];
  const closeoutRefs: string[] = [];
  const humanGateRefs: string[] = [];
  parseCliOptions(rest, 1, (token, value) => {
    if (token === '--new-stage-run') {
      newStageRun = true;
      return false;
    } else if (token === '--stage-run-invocation-id' && value) {
      stageRunInvocationId = value;
      return true;
    } else if (token === '--parent-route-decision-ref' && value) {
      parentRouteDecisionRef = value;
      return true;
    } else if (token === '--start') {
      start = true;
      return false;
    } else if (token === '--domain' && value) {
      domainId = assertDomainId(value);
      return true;
    } else if (token === '--stage' && value) {
      stageId = value;
      return true;
    } else if (token === '--action' && value) {
      actionId = value;
      return true;
    } else if (token === '--provider' && value) {
      providerKind = assertProviderKind(value);
      return true;
    } else if (token === '--workspace-locator' && value) {
      workspaceLocator = value;
      return true;
    } else if (token === '--workspace-locator-file' && value) {
      workspaceLocatorFile = value;
      return true;
    } else if (token === '--scope-kind' && value) {
      if (value !== 'work_item' && value !== 'domain' && value !== 'system') {
        throw new FrameworkContractError('cli_usage_error', `Unsupported execution scope kind: ${value}.`, {
          allowed_scope_kinds: ['work_item', 'domain', 'system'],
        });
      }
      scopeKind = value;
      return true;
    } else if (token === '--execution-scope' && value) {
      executionScope = value;
      return true;
    } else if (token === '--execution-scope-file' && value) {
      executionScopeFile = value;
      return true;
    } else if (token === '--retry-budget' && value) {
      retryBudget = value;
      return true;
    } else if (token === '--retry-budget-file' && value) {
      retryBudgetFile = value;
      return true;
    } else if (token === '--source-fingerprint' && value) {
      sourceFingerprint = value;
      return true;
    } else if (token === '--executor-kind' && value) {
      executorKind = value;
      return true;
    } else if (token === '--executor-binding-ref' && value) {
      executorBindingRef = value;
      return true;
    } else if (token === '--invocation-mode' && value) {
      if (value !== 'invocation' && value !== 'authoring') {
        throw new FrameworkContractError('cli_usage_error', `Unsupported family-runtime attempt invocation mode: ${value}.`, {
          allowed_modes: ['invocation', 'authoring'],
        });
      }
      invocationMode = value;
      return true;
    } else if (token === '--bounded-edit-ref' && value) {
      boundedEditRef = value;
      return true;
    } else if (token === '--review-lane' && value) {
      reviewLane = value;
      return true;
    } else if (token === '--task' && value) {
      taskId = value;
      return true;
    } else if (token === '--checkpoint-ref' && value) {
      checkpointRefs.push(value);
      return true;
    } else if (token === '--input-artifact-ref' && value) {
      inputArtifactRefs.push(value);
      return true;
    } else if (token === '--input-artifact-sha256' && value) {
      inputArtifactHashes.push(value);
      return true;
    } else if (token === '--closeout-ref' && value) {
      closeoutRefs.push(value);
      return true;
    } else if (token === '--human-gate-ref' && value) {
      humanGateRefs.push(value);
      return true;
    } else if (token === '--blocked-reason' && value) {
      blockedReason = value;
      return true;
    } else {
      throw new FrameworkContractError('cli_usage_error', `Unknown family-runtime attempt create option: ${token}.`, {
        option: token,
      });
    }
  });
  if (!domainId || !stageId) {
    throw new FrameworkContractError(
      'cli_usage_error',
      'family-runtime attempt create requires --domain and --stage.',
      { required: ['--domain', '--stage'] },
    );
  }
  if (!workspaceLocator && !workspaceLocatorFile) {
    throw new FrameworkContractError(
      'cli_usage_error',
      'family-runtime attempt create requires --workspace-locator or --workspace-locator-file.',
      { required: ['--workspace-locator', '--workspace-locator-file'] },
    );
  }
  return {
    mode: 'attempt_create',
    input: {
      domainId,
      stageId,
      actionId,
      providerKind,
      workspaceLocator: parsePayloadArg(workspaceLocator, workspaceLocatorFile),
      scopeKind,
      executionScope: executionScope || executionScopeFile
        ? parsePayloadArg(executionScope, executionScopeFile)
        : undefined,
      sourceFingerprint,
      executorKind,
      executorBindingRef,
      invocationMode,
      boundedEditRef,
      ...(reviewLane ? { reviewLane } : {}),
      taskId,
      retryBudget: retryBudget || retryBudgetFile ? parsePayloadArg(retryBudget, retryBudgetFile) : undefined,
      checkpointRefs,
      inputArtifactRefs,
      inputArtifactHashes,
      closeoutRefs,
      humanGateRefs,
      blockedReason,
      newStageRun,
      stageRunInvocationId,
      parentRouteDecisionRef,
      start,
    },
  };
}


type FamilyRuntimeAttemptStageRuntime = {
  ensurePackageLaunchReady?: typeof ensureFamilyRuntimePackageLaunchReady;
  resolveStageBinding?: typeof resolveStandardAgentStageQualityRuntimeBinding;
  startWorkflow?: (
    input: Parameters<typeof launchRegisteredStageRun>[0]['stageRunInput'],
    context: { paths: ReturnType<typeof familyRuntimePaths> },
  ) => Promise<Record<string, unknown>>;
  describeWorkflow?: (
    input: Parameters<typeof launchRegisteredStageRun>[0]['stageRunInput'],
    context: { paths: ReturnType<typeof familyRuntimePaths> },
  ) => Promise<Record<string, unknown>>;
  cancelWorkflow?: (
    input: {
      attempt: ReturnType<typeof inspectStageAttempt>;
      reason: string;
      source?: string;
    },
    context: { paths: ReturnType<typeof familyRuntimePaths> },
  ) => Promise<Record<string, unknown>>;
};

async function temporalProviderModule() {
  return await import('../family-runtime-temporal-provider.ts');
}

function parsedRuntimeRecord(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = parseJsonText(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function rawStageAttemptMutationAuthority(
  db: DatabaseSync,
  stageAttemptId: string,
  operation: string,
) {
  const row = db.prepare('SELECT * FROM stage_attempts WHERE stage_attempt_id = ?').get(
    stageAttemptId,
  ) as Record<string, unknown> | undefined;
  if (!row) {
    throw new FrameworkContractError('cli_usage_error', 'Stage attempt not found.', {
      stage_attempt_id: stageAttemptId,
      operation,
    });
  }
  requireRuntimeExecutionScopeMutationAllowed(db, row, operation);
  return row;
}

function stageAttemptAllowsRuntimeRefresh(
  db: DatabaseSync,
  stageAttemptId: string,
  operation: string,
) {
  try {
    rawStageAttemptMutationAuthority(db, stageAttemptId, operation);
    return true;
  } catch (error) {
    if (
      error instanceof FrameworkContractError
      && error.details?.failure_code === 'runtime_execution_identity_unresolved'
    ) {
      return false;
    }
    throw error;
  }
}

function runtimeRowWorkspaceRoot(row: Record<string, unknown>) {
  const locator = parsedRuntimeRecord(row.workspace_locator_json);
  if (locator) {
    return typeof locator.workspace_root === 'string'
      ? locator.workspace_root.trim()
      : typeof locator.repo_root === 'string'
        ? locator.repo_root.trim()
        : null;
  }
  const stageRunInput = parsedRuntimeRecord(row.stage_run_input_json);
  const stageRunLocator = isRecord(stageRunInput?.workspace_locator)
    ? stageRunInput.workspace_locator
    : null;
  return typeof stageRunLocator?.workspace_root === 'string'
    ? stageRunLocator.workspace_root.trim()
    : typeof stageRunLocator?.repo_root === 'string'
      ? stageRunLocator.repo_root.trim()
      : null;
}

function requireCurrentRuntimeRowsBeforeLaunchSideEffects(input: {
  db: DatabaseSync;
  domainId: string;
  stageId: string;
  workspaceRoot: string | null;
  operation: string;
}) {
  for (const table of ['stage_attempts', 'stage_run_launches'] as const) {
    const exists = input.db.prepare(
      'SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?',
    ).get(table);
    if (!exists) continue;
    const statusPredicate = table === 'stage_attempts'
      ? "status NOT IN ('completed', 'failed', 'dead_lettered') AND archived_at IS NULL"
      : "launch_status <> 'closed'";
    const rows = input.db.prepare(`
      SELECT * FROM ${table}
      WHERE domain_id = ? AND stage_id = ? AND ${statusPredicate}
    `).all(input.domainId, input.stageId) as Record<string, unknown>[];
    for (const row of rows) {
      try {
        const admission = requireRuntimeExecutionScopeMutationAllowed(input.db, row, input.operation);
        const rowWorkspaceRoot = admission.executionScope?.workspace_root ?? runtimeRowWorkspaceRoot(row);
        if (input.workspaceRoot && rowWorkspaceRoot && rowWorkspaceRoot !== input.workspaceRoot) continue;
      } catch (error) {
        if (
          error instanceof FrameworkContractError
          && error.details?.failure_code === 'runtime_execution_identity_unresolved'
        ) {
          const rowWorkspaceRoot = typeof error.details.workspace_root === 'string'
            ? error.details.workspace_root
            : null;
          if (input.workspaceRoot && !rowWorkspaceRoot) continue;
          if (input.workspaceRoot && rowWorkspaceRoot && rowWorkspaceRoot !== input.workspaceRoot) continue;
        }
        throw error;
      }
    }
  }
}

function stageRunReplayBusinessIdentity(
  input: Parameters<typeof launchRegisteredStageRun>[0]['stageRunInput'],
) {
  const spec = input.stage_run_spec;
  const { native_package_closure: _nativePackageClosure, ...workspaceIdentity } = spec.workspace_identity;
  return {
    scope_kind: input.scope_kind ?? (input.execution_scope ? 'work_item' : 'domain'),
    execution_scope: input.execution_scope ?? null,
    domain_id: spec.domain_id,
    stage_id: spec.stage_id,
    action_id: spec.action_id,
    task_id: spec.task_id,
    workspace_identity: workspaceIdentity,
    source_fingerprint: spec.source_fingerprint,
    input_artifacts: spec.input_artifacts,
    executor_kind: spec.executor_kind,
    stage_attempt_executor_policy: spec.stage_attempt_executor_policy,
    parent_route_decision_ref: spec.parent_route_decision_ref,
    checkpoint_refs: spec.checkpoint_refs.filter((ref) => ref !== spec.stage_packet_ref),
  };
}

function normalizedReplayStringList(values: unknown) {
  return Array.isArray(values)
    ? [...new Set(values
        .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
        .map((value) => value.trim()))]
    : [];
}

function stageRunReplayRequestBusinessIdentity(input: {
  domainId: Parameters<typeof buildCliStageRunInvocationId>[0]['domainId'];
  stageId: string;
  actionId?: string;
  taskId?: string;
  workspaceLocator: Record<string, unknown>;
  sourceFingerprint?: string;
  executorKind?: string;
  executorBindingRef?: string;
  invocationMode?: string;
  boundedEditRef?: string;
  reviewLane?: string;
  parentRouteDecisionRef?: string;
  checkpointRefs?: string[];
  inputArtifactRefs?: string[];
  inputArtifactHashes?: string[];
  scopeKind?: 'work_item' | 'domain' | 'system';
  executionScope?: Record<string, unknown> | null;
}) {
  const artifactRefs = Array.isArray(input.inputArtifactRefs)
    ? input.inputArtifactRefs
        .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
        .map((value) => value.trim())
    : [];
  const artifactHashes = input.inputArtifactHashes ?? [];
  if (artifactRefs.length !== artifactHashes.length) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'StageRun immutable input artifact refs and hashes must have equal cardinality.',
      { artifact_ref_count: artifactRefs.length, artifact_hash_count: artifactHashes.length },
    );
  }
  const artifactIndex = new Map<string, { sha256: string; identity_receipt_ref: null }>();
  artifactRefs.forEach((ref, index) => {
    const artifact = {
      sha256: canonicalStageRunSha256(artifactHashes[index], `input_artifact_hashes[${index}]`),
      identity_receipt_ref: null,
    };
    const existing = artifactIndex.get(ref);
    if (existing && existing.sha256 !== artifact.sha256) {
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'One StageRun input artifact ref cannot be bound to conflicting hashes or receipts.',
        {
          artifact_ref: ref,
          existing_sha256: existing.sha256,
          received_sha256: artifact.sha256,
        },
      );
    }
    artifactIndex.set(ref, artifact);
  });
  const inputArtifacts = [...artifactIndex.entries()]
    .map(([ref, artifact]) => ({ ref, ...artifact }))
    .sort((left, right) => left.ref.localeCompare(right.ref) || left.sha256.localeCompare(right.sha256));
  const checkpointRefs = normalizedReplayStringList(input.checkpointRefs);
  const stagePacketRef = checkpointRefs[0] ?? null;
  const stageAttemptExecutorPolicy = {
    ...(input.executorBindingRef ? { executor_binding_ref: input.executorBindingRef } : {}),
    ...(input.invocationMode ? { invocation_mode: input.invocationMode } : {}),
    ...(input.boundedEditRef ? { bounded_edit_ref: input.boundedEditRef } : {}),
    ...(input.reviewLane ? { review_lane_binding: input.reviewLane } : {}),
  };
  return {
    scope_kind: input.scopeKind ?? (input.executionScope ? 'work_item' : 'domain'),
    execution_scope: input.executionScope ?? null,
    domain_id: input.domainId,
    stage_id: input.stageId.trim(),
    action_id: input.actionId?.trim() || null,
    task_id: input.taskId?.trim() || null,
    workspace_identity: stageRunWorkspaceIdentity(input.workspaceLocator),
    source_fingerprint: input.sourceFingerprint?.trim()
      ? canonicalStageRunSha256(input.sourceFingerprint, 'source_fingerprint')
      : null,
    input_artifacts: inputArtifacts,
    executor_kind: input.executorKind?.trim() || 'codex_cli',
    stage_attempt_executor_policy: stageAttemptExecutorPolicy,
    parent_route_decision_ref: input.parentRouteDecisionRef?.trim() || null,
    checkpoint_refs: stagePacketRef
      ? checkpointRefs.filter((ref) => ref !== stagePacketRef)
      : checkpointRefs,
  };
}

async function syncTemporalStageAttemptsForTask(
  db: DatabaseSync,
  paths: ReturnType<typeof familyRuntimePaths>,
  taskId: string,
) {
  const attempts = listStageAttemptsForTask(db, taskId).filter((attempt) => attempt.provider_kind === 'temporal');
  for (const attempt of attempts) {
    if (attempt.status === 'completed' && attempt.closeout_receipt_status) {
      continue;
    }
    if (!stageAttemptAllowsRuntimeRefresh(
      db,
      attempt.stage_attempt_id,
      'sync_temporal_stage_attempts_for_task',
    )) {
      continue;
    }
    const temporalQuery = await queryTemporalStageAttemptReadModel(attempt, { paths });
    syncStageAttemptFromTemporalTerminalObservation(db, temporalQuery);
  }
}

export async function runFamilyRuntimeAttemptCommand(context: {
  db: DatabaseSync;
  paths: ReturnType<typeof familyRuntimePaths>;
  parsed: FamilyRuntimeCommandInput;
  stageRunRuntime?: FamilyRuntimeAttemptStageRuntime;
  getCordisPackStagecraft: () => Promise<{
    stageBinding: CordisPackStageBindingService;
    stageContext: CordisStagecraftContextService;
  }>;
  managedProviderProjection: () => ReturnType<typeof readManagedProviderProjectionSummary>;
}): Promise<Record<string, unknown>> {
  const {
    db,
    paths,
    parsed,
    stageRunRuntime,
    getCordisPackStagecraft,
    managedProviderProjection,
  } = context;
  if (parsed.mode === 'attempt_create') {
    const runtimeExecutionScope = requireFamilyRuntimeExecutionScope({
      scopeKind: parsed.input.scopeKind,
      executionScope: parsed.input.executionScope,
      workspaceLocator: parsed.input.workspaceLocator,
      domainId: parsed.input.domainId,
      operation: 'family_runtime_attempt_create',
    });
    const scopedAttemptInput = {
      ...parsed.input,
      scopeKind: runtimeExecutionScope.scopeKind,
      executionScope: runtimeExecutionScope.executionScope,
    };
    requireCurrentRuntimeRowsBeforeLaunchSideEffects({
      db,
      domainId: parsed.input.domainId,
      stageId: parsed.input.stageId,
      workspaceRoot: runtimeExecutionScope.executionScope?.workspace_root
        ?? (typeof parsed.input.workspaceLocator.workspace_root === 'string'
          ? parsed.input.workspaceLocator.workspace_root.trim()
          : typeof parsed.input.workspaceLocator.repo_root === 'string'
            ? parsed.input.workspaceLocator.repo_root.trim()
            : null),
      operation: 'family_runtime_attempt_create_preflight',
    });
    const usesExplicitStageRunIdentity = Boolean(
      parsed.input.newStageRun
      || parsed.input.stageRunInvocationId
      || parsed.input.parentRouteDecisionRef
      || (parsed.input.inputArtifactRefs?.length ?? 0) > 0
      || (parsed.input.inputArtifactHashes?.length ?? 0) > 0
      || Boolean(parsed.input.reviewLane?.trim()),
    );
    const existingAttempt = usesExplicitStageRunIdentity
      ? null
      : findIdempotentStageAttempt(db, scopedAttemptInput);
    if (existingAttempt && !parsed.input.start) {
      rawStageAttemptMutationAuthority(
        db,
        existingAttempt.stage_attempt_id,
        'family_runtime_attempt_create_idempotent_replay',
      );
      return {
        version: 'g2',
        family_runtime_stage_attempt: {
          surface_id: 'opl_family_runtime_stage_attempt',
          created: false,
          idempotent_noop: true,
          attempt: existingAttempt,
          stage_context_observation: null,
          launch_invocation: null,
        },
      };
    }
    const baseStageRunInvocationId = buildCliStageRunInvocationId({
      domainId: parsed.input.domainId,
      stageId: parsed.input.stageId,
      actionId: parsed.input.actionId,
      workspaceLocator: parsed.input.workspaceLocator,
      taskId: parsed.input.taskId,
    });
    const stageRunInvocationId = parsed.input.stageRunInvocationId
      ? explicitStageRunInvocationId(parsed.input.stageRunInvocationId)
      : parsed.input.newStageRun
        ? stableId('sri', [baseStageRunInvocationId, 'explicit_new_stage_run', randomUUID()])
        : baseStageRunInvocationId;
    const stageRunId = deriveStageRunId({
      domainId: parsed.input.domainId,
      stageId: parsed.input.stageId,
      stageRunInvocationId,
    });
    const existingStageRunLaunch = findStageRunLaunch(db, stageRunId);
    const requestedReviewLane = parsed.input.reviewLane?.trim() || null;
    const explicitDomainPackRoot = typeof parsed.input.workspaceLocator.domain_pack_root === 'string'
      ? parsed.input.workspaceLocator.domain_pack_root.trim()
      : '';
    const persistedDomainPackRoot = existingStageRunLaunch?.stage_run_input.domain_pack_root?.trim() ?? '';
    const persistedStageAttemptExecutorPolicy = isRecord(
      existingStageRunLaunch?.stage_run_input.stage_run_spec.stage_attempt_executor_policy,
    )
      ? existingStageRunLaunch.stage_run_input.stage_run_spec.stage_attempt_executor_policy
      : null;
    const persistedReviewLane = typeof persistedStageAttemptExecutorPolicy?.review_lane_binding === 'string'
      ? persistedStageAttemptExecutorPolicy.review_lane_binding.trim() || null
      : null;
    if (existingStageRunLaunch && persistedReviewLane && requestedReviewLane) {
      // Persisted lane identity is the replay authority; an explicit different
      // lane must fail before immutable-spec comparison, without re-reading the
      // current package manifest.
      resolveStandardAgentStageReviewLane(
        {
          binding_kind: 'fixed',
          review_lane: persistedReviewLane,
          executor_may_select_lane: false,
          lane_fallback: false,
        },
        requestedReviewLane,
      );
    }
    const replayReviewLane = existingStageRunLaunch
      ? requestedReviewLane ?? persistedReviewLane
      : requestedReviewLane;
    if (existingStageRunLaunch && canonicalJsonText(
      stageRunReplayBusinessIdentity(existingStageRunLaunch.stage_run_input),
    ) !== canonicalJsonText(stageRunReplayRequestBusinessIdentity({
      ...scopedAttemptInput,
      reviewLane: replayReviewLane ?? undefined,
    }))) {
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'StageRun invocation is already bound to a different immutable spec.',
        {
          failure_code: 'stage_run_invocation_spec_conflict',
          domain_id: parsed.input.domainId,
          stage_id: parsed.input.stageId,
          stage_run_invocation_id: stageRunInvocationId,
          existing_stage_run_id: existingStageRunLaunch.stage_run_id,
          existing_stage_run_spec_sha256: existingStageRunLaunch.stage_run_spec_sha256,
        },
      );
    }
    const useBoundaryId = stableId('package-use', [stageRunInvocationId]);
    const pinnedUseBinding = isRecord(parsed.input.workspaceLocator.package_use_binding)
      ? parsed.input.workspaceLocator.package_use_binding
      : null;
    const packageReadiness = existingStageRunLaunch
      ? null
      : await (
          stageRunRuntime?.ensurePackageLaunchReady
          ?? ensureFamilyRuntimePackageLaunchReady
        )({
          domainId: parsed.input.domainId,
          workspaceLocator: parsed.input.workspaceLocator,
          ...(parsed.input.start ? { useBoundaryId } : {}),
          ...(pinnedUseBinding ? { pinnedUseBinding } : {}),
        });
    const managedDomainPackRoot = packageRuntimeSourceCheckoutPath(packageReadiness) ?? '';
    const domainPackRoot = persistedDomainPackRoot
      || (pinnedUseBinding
        ? explicitDomainPackRoot || managedDomainPackRoot
        : managedDomainPackRoot || explicitDomainPackRoot)
      || null;
    const cordis = await getCordisPackStagecraft();
    const stageQualityBinding = !existingStageRunLaunch && domainPackRoot
      ? (stageRunRuntime?.resolveStageBinding
        ?? cordis.stageBinding.resolve.bind(cordis.stageBinding))(domainPackRoot, parsed.input.stageId)
      : null;
    if (!existingStageRunLaunch && requestedReviewLane) {
      resolveStandardAgentStageReviewLane(stageQualityBinding?.review_lane_binding, requestedReviewLane);
    }
    const effectiveReviewLane = existingStageRunLaunch
      ? replayReviewLane
      : resolveStandardAgentStageReviewLane(stageQualityBinding?.review_lane_binding, requestedReviewLane);
    const selectedPackageUseBinding = parsed.input.start || stageQualityBinding?.enabled
      ? pinnedUseBinding ?? packageReadiness?.package_use_binding
      : null;
    const nativePackageClosure = isRecord(packageReadiness?.native_package_closure)
      ? packageReadiness.native_package_closure
      : null;
    const useBoundWorkspaceLocator = selectedPackageUseBinding
      ? {
          ...parsed.input.workspaceLocator,
          ...(domainPackRoot ? { domain_pack_root: domainPackRoot } : {}),
          ...(nativePackageClosure ? { native_package_closure: nativePackageClosure } : {}),
          package_use_binding: selectedPackageUseBinding,
        }
      : {
          ...parsed.input.workspaceLocator,
          ...(domainPackRoot ? { domain_pack_root: domainPackRoot } : {}),
          ...(nativePackageClosure ? { native_package_closure: nativePackageClosure } : {}),
        };
    const providerKind = resolveFamilyRuntimeProviderKind(parsed.input.providerKind);
    const sourceFingerprint = parsed.input.sourceFingerprint?.trim() || null;
    const taskId = parsed.input.taskId?.trim() || null;
    const baseIdempotencyKey = stableId('idem', [
      parsed.input.domainId,
      parsed.input.stageId,
      parsed.input.actionId?.trim() || null,
      providerKind,
      parsed.input.workspaceLocator,
      sourceFingerprint,
      taskId,
    ]);
    const projectedIdempotencyKey = baseIdempotencyKey;
    const defaultStageContextObservation = cordis.stageContext.observe(loadFrameworkContracts(), {
      domainId: parsed.input.domainId,
      stageId: parsed.input.stageId,
      actionId: parsed.input.actionId,
    });
    const checkoutCurrentnessPreflight = preflightDomainWorkspaceCheckoutCurrentness({
      domainId: parsed.input.domainId,
      workspaceLocator: parsed.input.workspaceLocator,
    });
    const checkoutBoundStageContextObservation = attachCheckoutCurrentnessToStageContext(
      defaultStageContextObservation,
      checkoutCurrentnessPreflight,
    );
    const lifecycleWorkspaceLocator = existingStageRunLaunch?.stage_run_input.workspace_locator
      ?? useBoundWorkspaceLocator;
    const canonicalLifecycleLaunch = Boolean(
      existingStageRunLaunch
      || domainPackRoot
      || parsed.input.actionId?.trim()
      || parsed.input.start
      || stageQualityBinding?.enabled,
    );
    const domainLifecycleAdmission = canonicalLifecycleLaunch
      ? preflightFamilyRuntimeDomainLifecycleAdmission({
          domainId: parsed.input.domainId,
          stageId: parsed.input.stageId,
          actionId: existingStageRunLaunch?.stage_run_input.action_id ?? parsed.input.actionId,
          domainPackRoot: existingStageRunLaunch?.stage_run_input.domain_pack_root ?? domainPackRoot,
          workspaceLocator: lifecycleWorkspaceLocator,
        })
      : { status: 'not_declared' as const };
    const stageLaunchContextObservation = {
      ...checkoutBoundStageContextObservation,
      domain_lifecycle_admission: domainLifecycleAdmission,
    };
    const launchInvocation = buildStageLaunchInvocationProjection({
      domainId: parsed.input.domainId,
      stageId: parsed.input.stageId,
      providerKind,
      workspaceLocator: parsed.input.workspaceLocator,
      sourceFingerprint,
      executorKind: parsed.input.executorKind,
      executorBindingRef: parsed.input.executorBindingRef,
      invocationMode: parsed.input.invocationMode,
      boundedEditRef: parsed.input.boundedEditRef,
      taskId,
      idempotencyKey: projectedIdempotencyKey,
      planeId: stageLaunchContextObservation.plane_id,
      contextPlaneId: stageLaunchContextObservation.plane_id,
    });
    const blockedReason = launchInvocation.blocker_reason
      ?? parsed.input.blockedReason
      ?? undefined;
    if (!existingAttempt && (existingStageRunLaunch || stageQualityBinding?.enabled)) {
      if (
        parsed.input.stageRunInvocationId
        && parsed.input.newStageRun
      ) {
        throw new FrameworkContractError(
          'cli_usage_error',
          '--stage-run-invocation-id cannot be combined with --new-stage-run.',
          {
            mutually_exclusive: [
              '--stage-run-invocation-id',
              '--new-stage-run',
            ],
          },
        );
      }
      const stageRunInput = existingStageRunLaunch?.stage_run_input
        ?? buildPackBoundTemporalStageRunInput({
          binding: stageQualityBinding!,
          domainPackRoot: domainPackRoot!,
          domainId: parsed.input.domainId,
          stageId: parsed.input.stageId,
          stageRunInvocationId,
          parentRouteDecisionRef: parsed.input.parentRouteDecisionRef,
          workspaceLocator: useBoundWorkspaceLocator,
          sourceFingerprint,
          executorKind: parsed.input.executorKind,
          stageAttemptExecutorPolicy: stageAttemptExecutorPolicyWithReviewLane({
            ...(parsed.input.executorBindingRef ? { executor_binding_ref: parsed.input.executorBindingRef } : {}),
            ...(parsed.input.invocationMode ? { invocation_mode: parsed.input.invocationMode } : {}),
            ...(parsed.input.boundedEditRef ? { bounded_edit_ref: parsed.input.boundedEditRef } : {}),
          }, effectiveReviewLane) ?? {},
          checkpointRefs: parsed.input.checkpointRefs,
          artifactRefs: parsed.input.inputArtifactRefs,
          artifactHashes: parsed.input.inputArtifactHashes,
          actionId: parsed.input.actionId,
          taskId,
          scopeKind: runtimeExecutionScope.scopeKind,
          executionScope: runtimeExecutionScope.executionScope,
          checkoutCurrentnessAdmission: checkoutCurrentnessPreflight,
        });
      const durableLaunch = await launchRegisteredStageRun({
        db,
        stageRunInput,
        start: Boolean(parsed.input.start && !blockedReason),
        startWorkflow: async (workflowInput) =>
          stageRunRuntime?.startWorkflow
            ? await stageRunRuntime.startWorkflow(workflowInput, { paths })
            : await (await temporalProviderModule()).startTemporalStageRunWorkflow(workflowInput, { paths }),
        describeWorkflow: async (workflowInput) =>
          stageRunRuntime?.describeWorkflow
            ? await stageRunRuntime.describeWorkflow(workflowInput, { paths })
            : await (await temporalProviderModule()).describeTemporalStageRunWorkflow(workflowInput, { paths }),
      });
      const temporal_start = parsed.input.start && !blockedReason
        ? durableLaunch.temporal_start
        : null;
      insertEvent(db, {
        taskId,
        domainId: parsed.input.domainId,
        eventType: blockedReason
          ? 'stage_run_launch_hard_stopped'
          : temporal_start
            ? 'stage_run_temporal_started'
            : 'stage_run_launch_planned',
        source: 'opl-cli',
        payload: {
          stage_run_id: stageRunInput.stage_run_id,
          stage_run_invocation_id: stageRunInput.stage_run_invocation_id,
          stage_run_spec_sha256: stageRunInput.stage_run_spec_sha256,
          workflow_id: stageRunInput.workflow_id,
          stage_id: stageRunInput.stage_id,
          quality_policy_ref: stageRunInput.quality_policy_ref,
          blocked_reason: blockedReason ?? null,
          temporal_start,
          durable_launch: durableLaunch,
        },
      });
      return {
        version: 'g2',
        family_runtime_stage_run: {
          surface_id: 'opl_family_runtime_stage_run',
          stage_run_input: stageRunInput,
          stage_context_observation: stageLaunchContextObservation,
          launch_invocation: launchInvocation,
          durable_launch: durableLaunch,
          blocked_reason: blockedReason ?? null,
          temporal_start,
        },
      };
    }
    if (
      parsed.input.newStageRun
      || parsed.input.stageRunInvocationId
      || parsed.input.parentRouteDecisionRef
      || (parsed.input.inputArtifactRefs?.length ?? 0) > 0
      || (parsed.input.inputArtifactHashes?.length ?? 0) > 0
      || Boolean(parsed.input.reviewLane?.trim())
    ) {
      throw new FrameworkContractError(
        'cli_usage_error',
        'StageRun identity and input artifact options require an enabled pack-bound Stage quality runtime.',
        {
          stage_id: parsed.input.stageId,
          stage_quality_runtime_enabled: false,
        },
      );
    }
    const result = existingAttempt
      ? {
          created: false,
          idempotent_noop: true,
          attempt: existingAttempt,
        }
      : createStageAttempt(db, {
          ...scopedAttemptInput,
          workspaceLocator: useBoundWorkspaceLocator,
          idempotencyWorkspaceLocator: parsed.input.workspaceLocator,
          blockedReason,
          routeImpact: defaultStageContextObservation.selected_action_id
            ? {
                selected_action_id: defaultStageContextObservation.selected_action_id,
                selected_stage_route: defaultStageContextObservation.selected_stage_route,
              }
            : undefined,
          launchContextObservation: stageLaunchContextObservation,
          launchInvocation,
        });
    const { attempt } = result;
    const stageLaunchHardStopped = Boolean(launchInvocation.blocker_reason);
    const launchAttempt = parsed.input.start && attempt.status !== 'blocked'
      ? persistStageAttemptLaunchBinding(db, attempt, {
          workspaceLocator: useBoundWorkspaceLocator,
          packageUseBinding: isRecord(selectedPackageUseBinding)
            ? selectedPackageUseBinding
            : null,
          domainPackRoot,
        })
      : attempt;
    const temporal_start = parsed.input.start
      && launchAttempt.status !== 'blocked'
        ? await (await temporalProviderModule()).startTemporalStageAttemptWorkflow(launchAttempt, { paths })
      : null;
    recordTemporalStartOnAttempt(db, launchAttempt, temporal_start);
    const projectedAttempt = inspectStageAttempt(db, attempt.stage_attempt_id);
    insertEvent(db, {
      taskId: projectedAttempt.task_id,
      domainId: parsed.input.domainId,
      eventType: stageLaunchHardStopped
        ? 'stage_attempt_launch_hard_stopped'
        : parsed.input.start
        ? 'stage_attempt_temporal_started'
        : result.idempotent_noop
          ? 'stage_attempt_idempotent_noop'
          : 'stage_attempt_created',
      source: 'opl-cli',
      payload: {
        stage_attempt_id: attempt.stage_attempt_id,
        idempotency_key: attempt.idempotency_key,
        provider_kind: attempt.provider_kind,
        stage_id: attempt.stage_id,
        task_id: attempt.task_id,
        stage_context_observation: stageLaunchContextObservation,
        launch_invocation: launchInvocation,
        temporal_start,
      },
    });
    return {
      version: 'g2',
      family_runtime_stage_attempt: {
        surface_id: 'opl_family_runtime_stage_attempt',
        created: result.created,
        idempotent_noop: result.idempotent_noop,
        attempt: projectedAttempt,
        stage_context_observation: stageLaunchContextObservation,
        launch_invocation: launchInvocation,
        conflict_or_blocker_envelopes: 'conflict_or_blocker_envelopes' in result
          ? result.conflict_or_blocker_envelopes
          : [
              ...launchInvocation.conflict_or_blocker_envelopes,
            ],
        temporal_start,
      },
    };
  }
  if (parsed.mode === 'attempt_start') {
    rawStageAttemptMutationAuthority(db, parsed.stageAttemptId, 'family_runtime_attempt_start_preflight');
    const attempt = inspectStageAttempt(db, parsed.stageAttemptId);
    if (attempt.attempt_role) {
      throw new FrameworkContractError(
        'cli_usage_error',
        'Quality-cycle StageAttempts can be started only by their StageRunController.',
        {
          stage_attempt_id: attempt.stage_attempt_id,
          stage_run_id: attempt.stage_run_id,
          attempt_role: attempt.attempt_role,
        },
      );
    }
    const workflowAlreadyStarted = typeof attempt.provider_run.first_execution_run_id === 'string'
      && attempt.provider_run.first_execution_run_id.length > 0;
    const persistedLaunchContext = isRecord(attempt.provider_run.execution_package_use_context)
      ? attempt.provider_run.execution_package_use_context
      : null;
    const launchBindingAlreadySelected = workflowAlreadyStarted
      || persistedLaunchContext?.status === 'attempt_launch_binding_persisted';
    const packageReadiness = launchBindingAlreadySelected
      ? null
      : await (
          stageRunRuntime?.ensurePackageLaunchReady
          ?? ensureFamilyRuntimePackageLaunchReady
        )({
          domainId: attempt.domain_id,
          workspaceLocator: attempt.workspace_locator,
          useBoundaryId: stableId('package-use', [
            'stage_attempt_start',
            attempt.stage_attempt_id,
          ]),
        });
    const refreshedDomainPackRoot = packageRuntimeSourceCheckoutPath(packageReadiness) ?? '';
    const refreshedNativePackageClosure = isRecord(packageReadiness?.native_package_closure)
      ? packageReadiness.native_package_closure
      : null;
    const refreshedWorkspaceLocator = packageReadiness?.package_use_binding || refreshedNativePackageClosure
      ? {
          ...attempt.workspace_locator,
          ...(refreshedDomainPackRoot ? { domain_pack_root: refreshedDomainPackRoot } : {}),
          ...(packageReadiness?.package_use_binding
            ? { package_use_binding: packageReadiness.package_use_binding }
            : {}),
          ...(refreshedNativePackageClosure
            ? { native_package_closure: refreshedNativePackageClosure }
            : {}),
        }
      : attempt.workspace_locator;
    const reboundAttempt = launchBindingAlreadySelected
      ? attempt
      : persistStageAttemptLaunchBinding(db, attempt, {
          workspaceLocator: refreshedWorkspaceLocator,
          packageUseBinding: isRecord(packageReadiness?.package_use_binding)
            ? packageReadiness.package_use_binding
            : null,
          domainPackRoot: refreshedDomainPackRoot || null,
        });
    rawStageAttemptMutationAuthority(db, parsed.stageAttemptId, 'family_runtime_attempt_start_provider_preflight');
    const reboundPackRoot = typeof reboundAttempt.workspace_locator.domain_pack_root === 'string'
      ? reboundAttempt.workspace_locator.domain_pack_root.trim()
      : '';
    const selectedActionId = isRecord(reboundAttempt.route_impact)
      && typeof reboundAttempt.route_impact.selected_action_id === 'string'
      ? reboundAttempt.route_impact.selected_action_id.trim()
      : typeof reboundAttempt.workspace_locator.action_ref === 'string'
        ? reboundAttempt.workspace_locator.action_ref.trim()
        : '';
    preflightFamilyRuntimeDomainLifecycleAdmission({
      domainId: reboundAttempt.domain_id,
      stageId: reboundAttempt.stage_id,
      actionId: selectedActionId || null,
      domainPackRoot: reboundPackRoot || null,
      workspaceLocator: reboundAttempt.workspace_locator,
    });
    const { startTemporalStageAttemptWorkflow } = await temporalProviderModule();
    const temporal_start = await startTemporalStageAttemptWorkflow(reboundAttempt, { paths });
    recordTemporalStartOnAttempt(db, reboundAttempt, temporal_start);
    const projectedAttempt = inspectStageAttempt(db, parsed.stageAttemptId);
    insertEvent(db, {
      taskId: projectedAttempt.task_id,
      domainId: projectedAttempt.domain_id,
      eventType: 'stage_attempt_temporal_started',
      source: 'opl-cli',
      payload: {
        stage_attempt_id: attempt.stage_attempt_id,
        provider_kind: attempt.provider_kind,
        temporal_start,
      },
    });
    return {
      version: 'g2',
      family_runtime_stage_attempt_start: {
        surface_id: 'opl_family_runtime_stage_attempt_start',
        attempt: projectedAttempt,
        temporal_start,
      },
    };
  }
  if (parsed.mode === 'attempt_cancel') {
    rawStageAttemptMutationAuthority(db, parsed.stageAttemptId, 'family_runtime_attempt_cancel_preflight');
    const attempt = inspectStageAttempt(db, parsed.stageAttemptId);
    const temporal_cancel = stageRunRuntime?.cancelWorkflow
      ? await stageRunRuntime.cancelWorkflow({
          attempt,
          reason: parsed.reason,
          source: parsed.source,
        }, { paths })
      : await (await temporalProviderModule()).cancelTemporalStageAttemptWorkflow({
          attempt,
          reason: parsed.reason,
          source: parsed.source,
          paths,
        });
    markStageAttemptCancelRequested(db, {
      stageAttemptId: parsed.stageAttemptId,
      reason: parsed.reason,
      source: parsed.source,
      temporalCancel: temporal_cancel,
    });
    const temporal_query = await queryTemporalStageAttemptReadModel(attempt, { paths });
    syncStageAttemptFromTemporalTerminalObservation(db, temporal_query);
    const projectedAttempt = await inspectStageAttemptWithCurrentProviderReadiness(db, parsed.stageAttemptId, paths, {
      managedProviderProjection: managedProviderProjection(),
    });
    insertEvent(db, {
      taskId: projectedAttempt.task_id,
      domainId: projectedAttempt.domain_id,
      eventType: 'stage_attempt_operator_cancel_requested',
      source: parsed.source ?? 'opl-cli',
      payload: {
        stage_attempt_id: attempt.stage_attempt_id,
        provider_kind: attempt.provider_kind,
        reason: parsed.reason,
        temporal_cancel,
        temporal_query,
        authority_boundary: {
          opl: 'provider_attempt_cancellation_transport_only',
          domain: 'truth_quality_artifact_gate_owner',
          provider_completion_is_domain_ready: false,
        },
      },
    });
    return {
      version: 'g2',
      family_runtime_stage_attempt_cancel: {
        surface_id: 'opl_family_runtime_stage_attempt_cancel',
        attempt: projectedAttempt,
        temporal_cancel,
        temporal_query,
      },
    };
  }
  if (parsed.mode === 'attempt_archive' || parsed.mode === 'attempt_restore') {
    const archived = parsed.mode === 'attempt_archive';
    const attempt = setStageAttemptArchived(db, {
      stageAttemptId: parsed.stageAttemptId,
      archived,
      reason: parsed.reason,
      source: parsed.source ?? 'opl-cli',
    });
    insertEvent(db, {
      taskId: attempt.task_id,
      domainId: attempt.domain_id,
      eventType: archived ? 'stage_attempt_archived' : 'stage_attempt_restored',
      source: parsed.source ?? 'opl-cli',
      payload: {
        stage_attempt_id: parsed.stageAttemptId,
        reason: parsed.reason,
        archived,
      },
    });
    return {
      version: 'g2',
      family_runtime_stage_attempt_archive: {
        surface_id: 'opl_family_runtime_stage_attempt_archive',
        action: archived ? 'archive' : 'restore',
        attempt,
      },
    };
  }
  if (parsed.mode === 'attempt_list') {
    const projection = await listStageAttemptsWithMonitoringProjection(db, paths, {
      managedProviderProjection: managedProviderProjection(),
    }, parsed.filters);
    return {
      version: 'g2',
      family_runtime_stage_attempts: {
        surface_id: 'opl_family_runtime_stage_attempts',
        provider_runtime_metadata: projection.provider_runtime_metadata,
        summary: projection.summary,
        filters: projection.filters,
        view_mode: projection.compact_timeline ? 'compact_timeline' : 'full',
        items: projection.compact_timeline ?? projection.attempts,
        attempts: projection.compact_timeline ?? projection.attempts,
        ...(projection.compact_timeline ? { compact_timeline: projection.compact_timeline } : {}),
      },
    };
  }
  if (parsed.mode === 'attempt_inspect') {
    const currentAttempt = inspectStageAttempt(db, parsed.stageAttemptId);
    const mayRefresh = stageAttemptAllowsRuntimeRefresh(
      db,
      parsed.stageAttemptId,
      'family_runtime_attempt_inspect_refresh',
    );
    const temporal_query = mayRefresh
      ? await queryTemporalStageAttemptReadModel(currentAttempt, { paths })
      : null;
    if (mayRefresh) syncStageAttemptFromTemporalTerminalObservation(db, temporal_query);
    return {
      version: 'g2',
      family_runtime_stage_attempt: {
        surface_id: 'opl_family_runtime_stage_attempt',
        attempt: await inspectStageAttemptWithCurrentProviderReadiness(db, parsed.stageAttemptId, paths, {
          managedProviderProjection: managedProviderProjection(),
        }),
        temporal_query,
      },
    };
  }
  if (parsed.mode === 'attempt_query') {
    const localQuery = queryStageAttempt(db, parsed.stageAttemptId);
    const attempt = localQuery.stage_attempt_query.attempt;
    const mayRefresh = stageAttemptAllowsRuntimeRefresh(
      db,
      parsed.stageAttemptId,
      'family_runtime_attempt_query_refresh',
    );
    const temporal_query = mayRefresh
      ? await queryTemporalStageAttemptReadModel(attempt, { paths })
      : null;
    if (mayRefresh) syncStageAttemptFromTemporalTerminalObservation(db, temporal_query);
    const projectedQuery = await queryStageAttemptWithCurrentProviderReadiness(db, parsed.stageAttemptId, paths, {
      managedProviderProjection: managedProviderProjection(),
    }, {
      temporalQuery: temporal_query && typeof temporal_query === 'object' && !Array.isArray(temporal_query)
        ? temporal_query
        : null,
    });
    return {
      version: 'g2',
      family_runtime_stage_attempt_query: {
        surface_id: 'opl_family_runtime_stage_attempt_query',
        attempt: projectedQuery.stage_attempt_query.attempt,
        attempt_ref: `opl://stage_attempts/${projectedQuery.stage_attempt_query.attempt.stage_attempt_id}`,
        attempt_status: projectedQuery.stage_attempt_query.attempt.status,
        current_provider_readiness: projectedQuery.stage_attempt_query.current_provider_readiness,
        temporal_durable_lifecycle_readback:
          projectedQuery.stage_attempt_query.temporal_durable_lifecycle_readback,
        ...projectedQuery,
        temporal_query,
      },
    };
  }
  if (parsed.mode === 'attempt_signal') {
    rawStageAttemptMutationAuthority(db, parsed.stageAttemptId, 'family_runtime_attempt_signal_preflight');
    const currentAttempt = inspectStageAttempt(db, parsed.stageAttemptId);
    if (currentAttempt.provider_kind !== 'temporal') {
      throw new FrameworkContractError('cli_usage_error', 'Temporal signal requires a temporal stage attempt.', {
        stage_attempt_id: currentAttempt.stage_attempt_id,
        provider_kind: currentAttempt.provider_kind,
      });
    }
    const signalPayload = bindTrustedCliFamilyRuntimeIngressIdentity({
      runtimeIdentity: currentAttempt,
      ingressPayload: parsed.payload,
      operation: `trusted_cli_signal_stage_attempt:${parsed.signalKind}`,
    });
    const temporal_signal = await (await temporalProviderModule()).signalTemporalStageAttemptWorkflow({
      attempt: currentAttempt,
      signalKind: parsed.signalKind,
      payload: signalPayload,
      source: parsed.source,
      paths,
    });
    const result = signalStageAttempt(db, { ...parsed, payload: signalPayload });
    insertEvent(db, {
      taskId: result.attempt.task_id,
      domainId: result.attempt.domain_id,
      eventType: 'stage_attempt_signal_received',
      source: parsed.source ?? 'opl-cli',
      payload: {
        stage_attempt_id: parsed.stageAttemptId,
        signal_kind: parsed.signalKind,
        signal_id: result.signal.signal_id,
        temporal_signal,
      },
    });
    return {
      version: 'g2',
      family_runtime_stage_attempt_signal: {
        surface_id: 'opl_family_runtime_stage_attempt_signal',
        ...result,
        temporal_signal,
      },
    };
  }
  if (parsed.mode === 'attempt_fixture_run') {
    rawStageAttemptMutationAuthority(db, parsed.stageAttemptId, 'family_runtime_attempt_fixture_preflight');
    const result = runStageAttemptFixtureActivity(db, parsed);
    insertEvent(db, {
      taskId: result.attempt.task_id,
      domainId: result.attempt.domain_id,
      eventType: 'stage_attempt_fixture_activity_ran',
      source: 'opl-cli',
      payload: {
        stage_attempt_id: parsed.stageAttemptId,
        provider_completion: result.provider_fixture_run.provider_completion,
      },
    });
    return {
      version: 'g2',
      family_runtime_stage_attempt_fixture_run: {
        surface_id: 'opl_family_runtime_stage_attempt_fixture_run',
        ...result,
      },
    };
  }
  throw new Error(`Unhandled family runtime attempt mode: ${(parsed as { mode: string }).mode}`);
}
