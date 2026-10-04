import assert from 'node:assert/strict';
import test from 'node:test';

import { scopedGatewayWorkspace } from '../foundry-kernel-cases/scoped-workspace.ts';
import { resolveFoundryExecutionScope } from '../../../src/adapters/execution/foundry-execution-scope.ts';
import { requireFamilyRuntimeExecutionScope } from '../../../src/adapters/execution/family-runtime-execution-scope.ts';
import { parseFamilyRuntimeCommand } from '../../../src/adapters/execution/family-runtime-command.ts';
import { createCordisStageRouteComposition } from '../../../src/host/plugins/cordis-agent-executor-experiment.ts';
import {
  OplFoundryProviderStageRunGateway,
  queryFoundryProviderStageRunHandle,
} from '../../../src/adapters/execution/foundry-provider-stage-run.ts';
import { activity, provider, state } from './support.ts';

export function registerGatewayTests(): void {
test('StageRun gateway uses the provider-declared public action instead of an OMA-specific constant', async (t) => {
  const workspaceRoot = scopedGatewayWorkspace(t);
  let args: string[] = [];
  const gateway = new OplFoundryProviderStageRunGateway((async (input: string[]) => {
    args = input;
    const command = parseFamilyRuntimeCommand(input);
    assert.equal(command.mode, 'attempt_create');
    if (command.mode !== 'attempt_create') throw new Error('Expected attempt_create');
    assert.equal(command.input.taskId, activity.run_id);
    assert.equal(command.input.scopeKind, 'work_item');
    const scope = requireFamilyRuntimeExecutionScope({
      scopeKind: command.input.scopeKind,
      executionScope: command.input.executionScope,
      workspaceLocator: command.input.workspaceLocator,
      domainId: command.input.domainId,
      operation: 'foundry-test-launch',
    });
    assert.ok(scope.executionScope?.canonical_work_item_root);
    assert.equal(scope.executionScope?.workspace_binding_id, 'binding:foundry-test');
    assert.deepEqual(command.input.inputArtifactHashes, [`sha256:${'2'.repeat(64)}`]);
    return {
      family_runtime_stage_run: {
        stage_run_input: { workflow_id: 'workflow:provider-action' },
      },
    };
  }) as never);
  await gateway.launch({
    provider,
    checkout_root: '/managed/provider',
    workspace_root: workspaceRoot,
    execution_scope: resolveFoundryExecutionScope({ provider, workspace_root: workspaceRoot, run_id: activity.run_id }),
    stage_id: 'mission-intake',
    stage_run_invocation_id: 'sri:provider-action',
    activity,
    input_artifact_refs: ['opl://foundry/input'],
    input_artifact_hashes: [`sha256:${'2'.repeat(64)}`],
  });
  assert.equal(args[args.indexOf('--action') + 1], 'engineer-fixture');
});

test('StageRun gateway forwards the Host Stagecraft composition to the runtime boundary', async (t) => {
  const workspaceRoot = scopedGatewayWorkspace(t);
  let composed = false;
  const gateway = new OplFoundryProviderStageRunGateway((async (_args, options) => {
    assert.equal(options?.createStageRouteComposition, createCordisStageRouteComposition);
    const composition = await options!.createStageRouteComposition!({});
    try {
      assert.equal(typeof composition.stageBinding.resolve, 'function');
      assert.equal(typeof composition.stageContext.observe, 'function');
      composed = true;
    } finally {
      await composition.dispose();
    }
    return { family_runtime_stage_run: { stage_run_input: { workflow_id: 'workflow:composition' } } };
  }) as typeof import('../../../src/adapters/execution/family-runtime.ts').runFamilyRuntime, {
    create_stage_route_composition: createCordisStageRouteComposition,
  });
  await gateway.launch({
    provider,
    checkout_root: '/managed/provider',
    workspace_root: workspaceRoot,
    execution_scope: resolveFoundryExecutionScope({ provider, workspace_root: workspaceRoot, run_id: activity.run_id }),
    stage_id: 'mission-intake',
    stage_run_invocation_id: 'sri:composition',
    activity,
    input_artifact_refs: [],
    input_artifact_hashes: [],
  });
  assert.equal(composed, true);
});

test('StageRun gateway projects authoritative Temporal failure over a stale running query', async (t) => {
  const client = {
    async withDeadline(_deadline: number, fn: () => Promise<unknown>) {
      return fn();
    },
  };
  const handle = {
    async describe() {
      return {
        workflowId: 'workflow:failed-stage-run',
        runId: 'run:failed-stage-run',
        status: { name: 'FAILED' },
        memo: {
          stage_run_id: 'stage-run:failed-stage-run',
          domain_id: 'agent_engineering',
          stage_id: 'mission-intake',
        },
      };
    },
    async query() {
      throw new Error('A failed workflow query would expose stale running state.');
    },
    async result() {
      throw new Error('A failed workflow has no successful result.');
    },
  };

  const result = await queryFoundryProviderStageRunHandle(client as never, handle as never);
  assert.deepEqual(result, {
    surface_kind: 'temporal_stage_run_query',
    provider_kind: 'temporal',
    stage_run_id: 'stage-run:failed-stage-run',
    workflow_id: 'workflow:failed-stage-run',
    run_id: 'run:failed-stage-run',
    workflow_status: 'FAILED',
    domain_id: 'agent_engineering',
    stage_id: 'mission-intake',
    status: 'failed',
    artifact_refs: [],
    artifact_hashes: [],
    attempts: [],
    next_stage_run_launch: null,
    blocked_reason: 'temporal_stage_run_workflow_failed',
  });
});

test('StageRun gateway reads the authoritative result after Temporal completion', async (t) => {
  const terminal = state({
    stage: 'evaluation-design',
    refs: ['file:///terminal.json'],
    hashes: [`sha256:${'a'.repeat(64)}`],
  });
  const client = {
    async withDeadline(_deadline: number, fn: () => Promise<unknown>) {
      return fn();
    },
  };
  const handle = {
    async describe() {
      return {
        workflowId: 'workflow:completed-stage-run',
        runId: 'run:completed-stage-run',
        status: { name: 'COMPLETED' },
        memo: {},
      };
    },
    async query() {
      throw new Error('Completed StageRun state must come from the workflow result.');
    },
    async result() {
      return terminal;
    },
  };

  assert.equal(
    await queryFoundryProviderStageRunHandle(client as never, handle as never),
    terminal,
  );
});

}
