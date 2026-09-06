import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { canonicalJsonBytes } from '../../../src/kernel/canonical-json.ts';
import { runFamilyRuntime } from '../../../src/adapters/execution/family-runtime.ts';
import type { HostedAgentRuntimeBindingResolver } from '../../../src/adapters/execution/hosted-agent-runtime-binding.ts';
import {
  inspectStandardAgentActionRunBinding,
  inspectStandardAgentActionRunCompletion,
  inspectStandardAgentActionRunPlan,
} from '../../../src/adapters/execution/standard-agent-action-run-state.ts';
import { runStandardAgentAction } from '../../../src/adapters/execution/standard-agent-action-runtime.ts';
import {
  prevalidatedSourceTruthFingerprint,
  readPrevalidatedSourceTruthRefs,
  requirePrevalidatedSourceTruthFingerprint,
} from '../../../src/adapters/execution/family-runtime-source-truth-refs.ts';
import { runStandardAgentHandlerSandbox } from '../../../src/adapters/execution/standard-agent-handler-sandbox.ts';
import { createCordisBaseHeadlessComposition } from '../../../src/host/composition-profiles.ts';

import { action, hostedSnapshot, managed, recordLedger, root, stagePackageUseBinding, writeContracts, writeStagePack, writeWorkItemInventory, writeWorkspaceRegistry } from '../standard-agent-action-runtime-shared.ts';

test('Hosted Stage action passes a SHA-bound request ref into Temporal StageRun create/start/query', async () => {
  const checkoutRoot = root('opl-stage-action-checkout-');
  const workspaceRoot = root('opl-stage-action-workspace-');
  const calls: string[][] = [];
  try {
    const stageRoute = {
      entry_stage_ref: 'intake',
      required_stage_refs: ['intake'],
      optional_stage_refs: [],
      terminal_stage_refs: ['intake'],
      route_policy: 'ai_selected_progress_route',
    };
    const stageAction = {
      ...action({
        actionId: 'launch',
        executionBinding: { kind: 'stage_binding', stage_manifest_ref: 'agent/stages/manifest.json' },
        stageRoute,
      }),
      required_fields: ['workspace_root', 'study_id', 'value'],
      optional_fields: ['work_item_id', 'quest_id'],
    };
    writeContracts(checkoutRoot, [stageAction]);
    fs.writeFileSync(path.join(checkoutRoot, 'contracts', 'input.schema.json'), `${JSON.stringify({
      $id: 'https://fixture.local/input.schema.json',
      type: 'object',
      required: ['workspace_root', 'study_id', 'value'],
      properties: {
        workspace_root: { type: 'string', minLength: 1 },
        study_id: { type: 'string', minLength: 1 },
        work_item_id: { type: 'string', minLength: 1 },
        quest_id: { type: 'string', minLength: 1 },
        value: { type: 'integer' },
      },
      additionalProperties: false,
    })}\n`);

    const result = await runStandardAgentAction({
      domainId: 'mas',
      actionId: 'launch',
      workspaceRoot,
      payload: {
        value: 3,
        study_id: 'study-001',
        work_item_id: 'work-item-001',
        quest_id: 'quest-001',
      },
      runId: 'stage-run',
    }, {
      resolveManagedCheckout: managed(checkoutRoot, workspaceRoot) as never,
      compileStageManifest: (() => ({})) as never,
      recordLedger,
      runStageRuntime: async (args) => {
        calls.push(args);
        if (args[0] === 'attempt') {
          return {
            family_runtime_stage_run: {
              stage_run_input: { workflow_id: 'wf-stage-run' },
              blocked_reason: null,
              temporal_start: { start_status: 'started' },
            },
          };
        }
        return { family_runtime_stage_run_query: { status: 'running' } };
      },
    });
    const run = result.standard_agent_action_run;
    assert.equal(run.execution_kind, 'stage_binding');
    if (run.execution_kind !== 'stage_binding') assert.fail('expected stage action result');
    assert.equal(run.status, 'started');
    assert.equal(run.ledger.status, 'started');
    assert.deepEqual(calls[1], ['stage-run', 'query', 'wf-stage-run']);
    const workspaceLocatorIndex = calls[0].indexOf('--workspace-locator');
    const runtimeWorkspaceLocator = JSON.parse(calls[0][workspaceLocatorIndex + 1]) as Record<string, unknown>;
    assert.equal(Object.hasOwn(runtimeWorkspaceLocator, 'package_use_binding'), false);
    assert.equal(runtimeWorkspaceLocator.hosted_runtime_binding_ref, run.hosted_runtime_binding_ref);
    assert.equal(runtimeWorkspaceLocator.domain_pack_root, fs.realpathSync.native(checkoutRoot));
    assert.equal(runtimeWorkspaceLocator.study_id, 'study-001');
    assert.equal(runtimeWorkspaceLocator.work_item_id, 'work-item-001');
    assert.equal(runtimeWorkspaceLocator.quest_id, 'quest-001');
    const checkpointIndex = calls[0].indexOf('--checkpoint-ref');
    assert.match(calls[0][checkpointIndex + 1], /^file:/);
    assert.equal(fs.existsSync(new URL(calls[0][checkpointIndex + 1])), true);
    const invocationIndex = calls[0].indexOf('--stage-run-invocation-id');
    assert.equal(calls[0][invocationIndex + 1], run.stage_run_invocation_id);
    const artifactRefIndex = calls[0].indexOf('--input-artifact-ref');
    const artifactHashIndex = calls[0].indexOf('--input-artifact-sha256');
    const sourceFingerprintIndex = calls[0].indexOf('--source-fingerprint');
    assert.equal(calls[0][artifactRefIndex + 1], calls[0][checkpointIndex + 1]);
    assert.equal(calls[0][artifactHashIndex + 1], calls[0][sourceFingerprintIndex + 1]);
    assert.deepEqual(run.temporal_stage_run_query, {
      family_runtime_stage_run_query: { status: 'running' },
    });
    assert.equal(run.temporal_stage_run_query_error, null);
  } finally {
    fs.rmSync(checkoutRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('Hosted Stage action binds prevalidated source truth refs without treating them as input files', async () => {
  const checkoutRoot = root('opl-stage-source-truth-checkout-');
  const workspaceRoot = root('opl-stage-source-truth-workspace-');
  const calls: string[][] = [];
  const sourceTruthRefs = {
    manifest_ref: 'opl-source-manifest:run-001',
    readiness_ref: 'opl-source-readiness:run-001',
    source_package_digest_ref: 'opl-source-package-digest:run-001',
  };
  try {
    const stageAction = {
      ...action({
        actionId: 'launch',
        executionBinding: { kind: 'stage_binding', stage_manifest_ref: 'agent/stages/manifest.json' },
        stageRoute: {
          entry_stage_ref: 'intake',
          required_stage_refs: ['intake'],
          optional_stage_refs: [],
          terminal_stage_refs: ['intake'],
          route_policy: 'ai_selected_progress_route',
        },
      }),
      optional_fields: ['source_truth_refs'],
    };
    writeContracts(checkoutRoot, [stageAction]);
    fs.writeFileSync(path.join(checkoutRoot, 'contracts', 'input.schema.json'), `${JSON.stringify({
      $id: 'https://fixture.local/input.schema.json',
      type: 'object',
      required: ['workspace_root', 'value'],
      properties: {
        workspace_root: { type: 'string', minLength: 1 },
        value: { type: 'integer' },
        source_truth_refs: {
          type: 'object',
          required: ['manifest_ref', 'readiness_ref', 'source_package_digest_ref'],
          properties: {
            manifest_ref: { type: 'string', minLength: 1 },
            readiness_ref: { type: 'string', minLength: 1 },
            source_package_digest_ref: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    })}\n`);
    const dependencies = {
      resolveManagedCheckout: managed(checkoutRoot, workspaceRoot) as never,
      compileStageManifest: (() => ({})) as never,
      recordLedger,
      runStageRuntime: async (args: string[]) => {
        calls.push(args);
        return args[0] === 'attempt'
          ? {
              family_runtime_stage_run: {
                stage_run_input: { workflow_id: 'wf-source-truth' },
                blocked_reason: null,
                temporal_start: { start_status: 'started' },
              },
            }
          : { family_runtime_stage_run_query: { status: 'running' } };
      },
    };
    const request = {
      domainId: 'mas',
      actionId: 'launch',
      workspaceRoot,
      payload: { value: 3, source_truth_refs: sourceTruthRefs },
      runId: 'source-truth-run',
    };
    await runStandardAgentAction(request, dependencies);
    await runStandardAgentAction(request, dependencies);

    const createCalls = calls.filter((args) => args[0] === 'attempt');
    assert.equal(createCalls.length, 1);
    const create = createCalls[0]!;
    const locator = JSON.parse(create[create.indexOf('--workspace-locator') + 1]) as Record<string, unknown>;
    assert.deepEqual(locator.source_truth_refs, sourceTruthRefs);
    const sourceFingerprint = create[create.indexOf('--source-fingerprint') + 1];
    const requestArtifactHash = create[create.indexOf('--input-artifact-sha256') + 1];
    assert.equal(sourceFingerprint, prevalidatedSourceTruthFingerprint(sourceTruthRefs));
    assert.notEqual(sourceFingerprint, requestArtifactHash);
    assert.equal(create.includes('--source-ref'), false);

    const callsBeforeConflict = calls.length;
    await assert.rejects(
      runStandardAgentAction({
        ...request,
        payload: {
          value: 3,
          source_truth_refs: { ...sourceTruthRefs, readiness_ref: 'opl-source-readiness:run-002' },
        },
      }, dependencies),
      /payload conflicts with its frozen run plan/i,
    );
    assert.equal(calls.length, callsBeforeConflict);
  } finally {
    fs.rmSync(checkoutRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('prevalidated source truth refs reject partial, body-bearing, and non-canonical shapes', () => {
  assert.equal(readPrevalidatedSourceTruthRefs(undefined), null);
  assert.throws(
    () => readPrevalidatedSourceTruthRefs({ manifest_ref: 'manifest', readiness_ref: 'ready' }),
    /exact declared fields/i,
  );
  assert.throws(
    () => readPrevalidatedSourceTruthRefs({
      manifest_ref: 'manifest',
      readiness_ref: 'ready',
      source_package_digest_ref: 'digest',
      source_body: 'forbidden',
    }),
    /exact declared fields/i,
  );
  assert.throws(
    () => readPrevalidatedSourceTruthRefs({
      manifest_ref: ' manifest ',
      readiness_ref: 'ready',
      source_package_digest_ref: 'digest',
    }),
    /canonical strings/i,
  );
  const refs = readPrevalidatedSourceTruthRefs({
    manifest_ref: 'manifest',
    readiness_ref: 'ready',
    source_package_digest_ref: 'digest',
  })!;
  assert.equal(
    requirePrevalidatedSourceTruthFingerprint(refs, prevalidatedSourceTruthFingerprint(refs)),
    prevalidatedSourceTruthFingerprint(refs),
  );
  assert.throws(
    () => requirePrevalidatedSourceTruthFingerprint(refs, `sha256:${'f'.repeat(64)}`),
    /exact canonical source fingerprint/i,
  );
});

test('work-item scoped Stage actions resolve one binding before Temporal and isolate Studies in one root', async () => {
  const checkoutRoot = root('opl-scoped-stage-action-checkout-');
  const workspaceRoot = root('opl-scoped-stage-action-workspace-');
  const stateRoot = root('opl-scoped-stage-action-state-');
  const previousStateRoot = process.env.OPL_STATE_DIR;
  const calls: string[][] = [];
  try {
    process.env.OPL_STATE_DIR = stateRoot;
    writeWorkspaceRegistry({ stateRoot, workspaceRoot });
    writeWorkItemInventory({
      checkoutRoot,
      workspaceRoot,
      studies: [
        { studyId: 'study-a', root: 'studies/study-a' },
        { studyId: 'study-b', root: 'studies/study-b' },
      ],
    });
    const stageAction = {
      ...action({
        actionId: 'launch-scoped',
        executionBinding: { kind: 'stage_binding', stage_manifest_ref: 'agent/stages/manifest.json' },
        stageRoute: {
          entry_stage_ref: 'intake',
          required_stage_refs: ['intake'],
          optional_stage_refs: [],
          terminal_stage_refs: ['intake'],
          route_policy: 'ai_selected_progress_route',
        },
      }),
      required_fields: ['workspace_root', 'study_id', 'value'],
      optional_fields: ['work_item_id'],
      execution_scope: { kind: 'work_item', alias_fields: ['study_id', 'work_item_id'] },
    };
    writeContracts(checkoutRoot, [stageAction]);
    fs.writeFileSync(path.join(checkoutRoot, 'contracts', 'input.schema.json'), `${JSON.stringify({
      $id: 'https://fixture.local/input.schema.json',
      type: 'object',
      required: ['workspace_root', 'study_id', 'value'],
      properties: {
        workspace_root: { type: 'string', minLength: 1 },
        study_id: { type: 'string', minLength: 1 },
        work_item_id: { type: 'string', minLength: 1 },
        value: { type: 'integer' },
      },
      additionalProperties: false,
    })}\n`);
    const runStageRuntime: typeof runFamilyRuntime = async (args) => {
      calls.push(args);
      if (args[0] === 'attempt') {
        return {
          family_runtime_stage_run: {
            stage_run_input: { workflow_id: `wf-${calls.length}` },
            blocked_reason: null,
            temporal_start: { start_status: 'started' },
          },
        } as never;
      }
      return { family_runtime_stage_run_query: { status: 'running' } } as never;
    };
    const runStudy = async (studyId: string) => await runStandardAgentAction({
      domainId: 'mas',
      actionId: 'launch-scoped',
      workspaceRoot,
      payload: { value: 3, study_id: studyId, work_item_id: studyId },
      runId: `scope-${studyId}`,
    }, {
      resolveManagedCheckout: managed(checkoutRoot, workspaceRoot) as never,
      compileStageManifest: (() => ({})) as never,
      recordLedger,
      runStageRuntime,
    });
    const studyA = (await runStudy('study-a')).standard_agent_action_run;
    const studyB = (await runStudy('study-b')).standard_agent_action_run;
    assert.equal(studyA.execution_kind, 'stage_binding');
    assert.equal(studyB.execution_kind, 'stage_binding');
    if (studyA.execution_kind !== 'stage_binding' || studyB.execution_kind !== 'stage_binding') assert.fail();
    assert.equal(studyA.execution_scope?.workspace_binding_id, 'binding:medautoscience:test');
    assert.equal(studyB.execution_scope?.workspace_binding_id, 'binding:medautoscience:test');
    assert.notEqual(studyA.execution_scope?.work_item_scope_id, studyB.execution_scope?.work_item_scope_id);
    assert.notEqual(studyA.execution_scope?.scope_digest, studyB.execution_scope?.scope_digest);
    assert.equal(
      studyA.execution_scope?.canonical_work_item_root,
      fs.realpathSync.native(path.join(workspaceRoot, 'studies', 'study-a')),
    );
    assert.match(studyA.execution_scope?.inventory_digest ?? '', /^sha256:[a-f0-9]{64}$/u);
    const createCalls = calls.filter((args) => args[0] === 'attempt');
    for (const [index, args] of createCalls.entries()) {
      const run: typeof studyA = index === 0 ? studyA : studyB;
      const inputRef = args[args.indexOf('--input-artifact-ref') + 1]!;
      assert.ok(inputRef.startsWith(pathToFileURL(`${run.execution_scope!.canonical_work_item_root}/`).href));
      assert.notEqual(inputRef, run.request.ref);
      assert.deepEqual(fs.readFileSync(new URL(inputRef)), fs.readFileSync(new URL(run.request.ref)));
      assert.equal(args[args.indexOf('--input-artifact-sha256') + 1], run.request.sha256);
      assert.equal(args[args.indexOf('--checkpoint-ref') + 1], inputRef);
    }
    assert.deepEqual(createCalls.map((args) => args[args.indexOf('--scope-kind') + 1]), [
      'work_item',
      'work_item',
    ]);
    assert.deepEqual(createCalls.map((args) => JSON.parse(
      args[args.indexOf('--execution-scope') + 1]!,
    ).scope_digest), [
      studyA.execution_scope?.scope_digest,
      studyB.execution_scope?.scope_digest,
    ]);
    const locators = createCalls.map((args) => JSON.parse(
      args[args.indexOf('--workspace-locator') + 1]!,
    ) as Record<string, unknown>);
    assert.deepEqual(locators.map((locator) => (
      locator.execution_scope as Record<string, unknown>
    ).scope_digest), [
      studyA.execution_scope?.scope_digest,
      studyB.execution_scope?.scope_digest,
    ]);
    assert.equal(inspectStandardAgentActionRunPlan({
      workspaceRoot,
      runId: 'scope-study-a',
    })?.execution_scope?.scope_digest, studyA.execution_scope?.scope_digest);

    const callsBeforeConflict = calls.length;
    await assert.rejects(
      runStandardAgentAction({
        domainId: 'mas',
        actionId: 'launch-scoped',
        workspaceRoot,
        payload: { value: 3, study_id: 'study-a', work_item_id: 'study-b' },
        runId: 'scope-conflict',
      }, {
        resolveManagedCheckout: managed(checkoutRoot, workspaceRoot) as never,
        compileStageManifest: (() => ({})) as never,
        recordLedger,
        runStageRuntime,
      }),
      (error: unknown) => {
        assert.equal((error as { details?: Record<string, unknown> }).details?.failure_code, 'work_item_identity_conflict');
        return true;
      },
    );
    assert.equal(calls.length, callsBeforeConflict);
  } finally {
    if (previousStateRoot === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateRoot;
    fs.rmSync(checkoutRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('work-item Handler actions restrict reads to one Study and replay the exact execution scope', async () => {
  const checkoutRoot = root('opl-scoped-handler-action-checkout-');
  const workspaceRoot = root('opl-scoped-handler-action-workspace-');
  const stateRoot = root('opl-scoped-handler-action-state-');
  const previousStateRoot = process.env.OPL_STATE_DIR;
  const handlerInputs: Array<Parameters<typeof runStandardAgentHandlerSandbox>[0]> = [];
  try {
    process.env.OPL_STATE_DIR = stateRoot;
    writeWorkspaceRegistry({ stateRoot, workspaceRoot });
    writeWorkItemInventory({
      checkoutRoot,
      workspaceRoot,
      studies: [
        { studyId: 'study-a', root: 'studies/study-a' },
        { studyId: 'study-b', root: 'studies/study-b' },
      ],
    });
    const handlerAction = {
      ...action({
        actionId: 'inspect-scoped',
        executionBinding: { kind: 'handler_ref', handler_ref: 'handler:fixture.inspect_scoped' },
      }),
      required_fields: ['workspace_root', 'study_id', 'value', 'target'],
      optional_fields: ['work_item_id'],
      execution_scope: { kind: 'work_item', alias_fields: ['study_id', 'work_item_id'] },
    };
    writeContracts(checkoutRoot, [handlerAction], {
      surface_kind: 'domain_handler_registry',
      version: 'domain-handler-registry.v1',
      handlers: [{
        handler_id: 'fixture.inspect_scoped',
        binding: { kind: 'python_callable', module: 'sample.handler', callable: 'evaluate' },
      }],
    });
    fs.writeFileSync(path.join(checkoutRoot, 'contracts', 'input.schema.json'), `${JSON.stringify({
      $id: 'https://fixture.local/input.schema.json',
      type: 'object',
      required: ['workspace_root', 'study_id', 'value', 'target'],
      properties: {
        workspace_root: { type: 'string', minLength: 1 },
        study_id: { type: 'string', minLength: 1 },
        work_item_id: { type: 'string', minLength: 1 },
        value: { type: 'integer' },
        target: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    })}\n`);
    fs.writeFileSync(path.join(checkoutRoot, 'contracts', 'output.schema.json'), `${JSON.stringify({
      $id: 'https://fixture.local/output.schema.json',
      type: 'object',
      required: ['accepted', 'value'],
      properties: {
        accepted: { const: true },
        value: { type: 'string' },
      },
      additionalProperties: false,
    })}\n`);
    fs.mkdirSync(path.join(checkoutRoot, 'src', 'sample'), { recursive: true });
    fs.writeFileSync(path.join(checkoutRoot, 'src', 'sample', '__init__.py'), '');
    fs.writeFileSync(path.join(checkoutRoot, 'src', 'sample', 'handler.py'), [
      'def evaluate(request):',
      '    with open(request["target"], encoding="utf-8") as handle:',
      '        return {"accepted": True, "value": handle.read()}',
      '',
    ].join('\n'));
    const studyARoot = fs.realpathSync.native(path.join(workspaceRoot, 'studies', 'study-a'));
    const studyBRoot = fs.realpathSync.native(path.join(workspaceRoot, 'studies', 'study-b'));
    const studyAFile = path.join(studyARoot, 'evidence.txt');
    const studyBFile = path.join(studyBRoot, 'evidence.txt');
    fs.writeFileSync(studyAFile, 'study-a-evidence');
    fs.writeFileSync(studyBFile, 'study-b-secret');
    const dependencies = {
      resolveManagedCheckout: managed(checkoutRoot, workspaceRoot) as never,
      runHandler: (input: Parameters<typeof runStandardAgentHandlerSandbox>[0]) => {
        handlerInputs.push(input);
        return runStandardAgentHandlerSandbox(input);
      },
      recordLedger,
    };
    const request = (input: {
      runId: string;
      studyId: string;
      target: string;
      workItemId?: string;
    }) => ({
      domainId: 'mas',
      actionId: 'inspect-scoped',
      workspaceRoot,
      payload: {
        value: 1,
        study_id: input.studyId,
        ...(input.workItemId ? { work_item_id: input.workItemId } : {}),
        target: input.target,
      },
      runId: input.runId,
    });

    const first = await runStandardAgentAction(request({
      runId: 'scoped-handler-study-a',
      studyId: 'study-a',
      target: studyAFile,
    }), dependencies);
    const replay = await runStandardAgentAction(request({
      runId: 'scoped-handler-study-a',
      studyId: 'study-a',
      target: studyAFile,
    }), dependencies);
    const firstRun = first.standard_agent_action_run;
    const replayRun = replay.standard_agent_action_run;
    assert.equal(firstRun.execution_kind, 'handler_ref');
    assert.equal(replayRun.execution_kind, 'handler_ref');
    if (firstRun.execution_kind !== 'handler_ref' || replayRun.execution_kind !== 'handler_ref') assert.fail();
    assert.deepEqual(firstRun.result, { accepted: true, value: 'study-a-evidence' });
    assert.deepEqual(replayRun.result, firstRun.result);
    assert.deepEqual(replayRun.execution_scope, firstRun.execution_scope);
    assert.equal(firstRun.execution_scope?.domain_work_item_id, 'study-a');
    assert.equal(firstRun.execution_scope?.canonical_work_item_root, studyARoot);
    assert.equal(handlerInputs.length, 1);
    assert.equal(handlerInputs[0]?.workspaceRoot, fs.realpathSync.native(workspaceRoot));
    assert.equal(handlerInputs[0]?.workspaceReadRoot, studyARoot);
    assert.deepEqual(
      inspectStandardAgentActionRunPlan({ workspaceRoot, runId: 'scoped-handler-study-a' })?.execution_scope,
      firstRun.execution_scope,
    );

    await assert.rejects(
      runStandardAgentAction(request({
        runId: 'scoped-handler-sibling-read',
        studyId: 'study-a',
        target: studyBFile,
      }), dependencies),
      (error: unknown) => {
        assert.equal(
          (error as { details?: Record<string, unknown> }).details?.failure_code,
          'standard_agent_handler_execution_failed',
        );
        return true;
      },
    );
    assert.equal(handlerInputs.at(-1)?.workspaceReadRoot, studyARoot);

    const callsBeforeIdentityConflict = handlerInputs.length;
    await assert.rejects(
      runStandardAgentAction(request({
        runId: 'scoped-handler-identity-conflict',
        studyId: 'study-a',
        workItemId: 'study-b',
        target: studyAFile,
      }), dependencies),
      (error: unknown) => {
        assert.equal(
          (error as { details?: Record<string, unknown> }).details?.failure_code,
          'work_item_identity_conflict',
        );
        return true;
      },
    );
    assert.equal(handlerInputs.length, callsBeforeIdentityConflict);

    await runStandardAgentAction(request({
      runId: 'scoped-handler-legacy-replay',
      studyId: 'study-a',
      target: studyAFile,
    }), dependencies);
    const legacyStateRoot = path.join(
      workspaceRoot,
      'control',
      'opl',
      'action_run_state',
      'scoped-handler-legacy-replay',
    );
    const legacyBindingPath = path.join(legacyStateRoot, 'binding.json');
    const legacyBinding = JSON.parse(fs.readFileSync(legacyBindingPath, 'utf8')) as Record<string, unknown>;
    legacyBinding.version = 'opl-standard-agent-action-run-binding.v1';
    delete legacyBinding.plan_sha256;
    delete legacyBinding.plan_byte_size;
    fs.writeFileSync(legacyBindingPath, canonicalJsonBytes(legacyBinding));
    fs.rmSync(path.join(legacyStateRoot, 'plan.json'));
    const callsBeforeLegacyReplay = handlerInputs.length;
    await assert.rejects(
      runStandardAgentAction(request({
        runId: 'scoped-handler-legacy-replay',
        studyId: 'study-a',
        target: studyAFile,
      }), dependencies),
      (error: unknown) => {
        assert.equal(
          (error as { details?: Record<string, unknown> }).details?.failure_code,
          'standard_agent_handler_replay_execution_scope_unresolved',
        );
        return true;
      },
    );
    assert.equal(handlerInputs.length, callsBeforeLegacyReplay);

    const planPath = path.join(
      workspaceRoot,
      'control',
      'opl',
      'action_run_state',
      'scoped-handler-study-a',
      'plan.json',
    );
    const bindingPath = path.join(path.dirname(planPath), 'binding.json');
    const tamperedPlan = JSON.parse(fs.readFileSync(planPath, 'utf8')) as Record<string, unknown>;
    const tamperedBinding = JSON.parse(fs.readFileSync(bindingPath, 'utf8')) as Record<string, unknown>;
    delete tamperedPlan.execution_scope;
    const tamperedPlanBytes = canonicalJsonBytes(tamperedPlan);
    tamperedBinding.plan_sha256 = crypto.createHash('sha256').update(tamperedPlanBytes).digest('hex');
    tamperedBinding.plan_byte_size = tamperedPlanBytes.byteLength;
    fs.writeFileSync(planPath, tamperedPlanBytes);
    fs.writeFileSync(bindingPath, canonicalJsonBytes(tamperedBinding));
    await assert.rejects(
      runStandardAgentAction(request({
        runId: 'scoped-handler-study-a',
        studyId: 'study-a',
        target: studyAFile,
      }), dependencies),
      /execution scope conflicts with its selected action/i,
    );
    assert.equal(handlerInputs.length, callsBeforeLegacyReplay);
  } finally {
    if (previousStateRoot === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateRoot;
    fs.rmSync(checkoutRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('Hosted Stage action replays one durable registry launch and starts a later run separately', async () => {
  const checkoutRoot = root('opl-stage-action-durable-checkout-');
  const workspaceRoot = root('opl-stage-action-durable-workspace-');
  const stateRoot = root('opl-stage-action-durable-state-');
  const previousStateRoot = process.env.OPL_STATE_DIR;
  const stageBinding = writeStagePack(checkoutRoot);
  const startedWorkflowIds: string[] = [];
  const firstExecutionByWorkflow = new Map<string, string>();
  let stageRuntimeCreateCalls = 0;
  let currentBindingResolutions = 0;
  let pinnedBindingResolutions = 0;
  const host = await createCordisBaseHeadlessComposition();
  try {
    process.env.OPL_STATE_DIR = stateRoot;
    writeContracts(checkoutRoot, [action({
      actionId: 'launch',
      executionBinding: { kind: 'stage_binding', stage_manifest_ref: 'agent/stages/manifest.json' },
      stageRoute: {
        entry_stage_ref: 'intake',
        required_stage_refs: ['intake'],
        optional_stage_refs: [],
        terminal_stage_refs: ['intake'],
        route_policy: 'ai_selected_progress_route',
      },
    })]);
    const runStageRuntime: typeof runFamilyRuntime = async (args) => {
      if (args[0] === 'attempt' && args[1] === 'create') stageRuntimeCreateCalls += 1;
      return await runFamilyRuntime(args, {
        createStageRouteComposition: host.services.childFactories.createStageRouteComposition,
        stageRunRuntime: {
          ensurePackageLaunchReady: async () => ({
            launch_allowed: true,
            runtime_source_readiness: { checkout_path: checkoutRoot },
            package_use_binding: stagePackageUseBinding(),
          } as never),
          resolveStageBinding: () => stageBinding,
          startWorkflow: async (input) => {
            startedWorkflowIds.push(input.workflow_id);
            const firstExecutionRunId = `run-${input.stage_run_id}`;
            firstExecutionByWorkflow.set(input.workflow_id, firstExecutionRunId);
            return {
              workflow_id: input.workflow_id,
              first_execution_run_id: firstExecutionRunId,
              workflow_status: 'RUNNING',
            };
          },
          describeWorkflow: async (input) => ({
            workflow_found: true,
            workflow_id: input.workflow_id,
            first_execution_run_id: firstExecutionByWorkflow.get(input.workflow_id),
            workflow_status: 'RUNNING',
          }),
          queryWorkflow: async ({ workflowId }) => ({
            workflow_id: workflowId,
            workflow_status: 'RUNNING',
          }),
        },
      });
    };
    const v1Snapshot = hostedSnapshot({ checkoutRoot, workspaceRoot, label: 'stage-v1' });
    const v2Snapshot = hostedSnapshot({ checkoutRoot, workspaceRoot, label: 'stage-v2' });
    let activeSnapshot = v1Snapshot;
    const snapshots = new Map([
      [v1Snapshot.provenance_ref, v1Snapshot],
      [v2Snapshot.provenance_ref, v2Snapshot],
    ]);
    const dependencies = {
      resolveRuntimeBinding: async () => {
        currentBindingResolutions += 1;
        return activeSnapshot;
      },
      resolvePinnedRuntimeBinding: async (
        input: Parameters<HostedAgentRuntimeBindingResolver['resolvePinned']>[0],
      ) => {
        pinnedBindingResolutions += 1;
        return snapshots.get(input.provenance_ref)
          ?? assert.fail(`missing pinned snapshot ${input.provenance_ref}`);
      },
      compileStageManifest: (() => ({})) as never,
      recordLedger,
      runStageRuntime,
    };

    const first = await runStandardAgentAction({
      domainId: 'mas', actionId: 'launch', workspaceRoot, payload: { value: 11 }, runId: 'hosted-one',
    }, dependencies);
    activeSnapshot = v2Snapshot;
    const replay = await runStandardAgentAction({
      domainId: 'mas', actionId: 'launch', workspaceRoot, payload: { value: 11 }, runId: 'hosted-one',
    }, dependencies);
    const later = await runStandardAgentAction({
      domainId: 'mas', actionId: 'launch', workspaceRoot, payload: { value: 11 }, runId: 'hosted-two',
    }, dependencies);

    const firstRun = first.standard_agent_action_run;
    const replayRun = replay.standard_agent_action_run;
    const laterRun = later.standard_agent_action_run;
    assert.equal(firstRun.execution_kind, 'stage_binding');
    assert.equal(replayRun.execution_kind, 'stage_binding');
    assert.equal(laterRun.execution_kind, 'stage_binding');
    if (
      firstRun.execution_kind !== 'stage_binding'
      || replayRun.execution_kind !== 'stage_binding'
      || laterRun.execution_kind !== 'stage_binding'
    ) assert.fail('expected stage-bound hosted action results');
    assert.equal(firstRun.stage_run_invocation_id, replayRun.stage_run_invocation_id);
    assert.notEqual(firstRun.stage_run_invocation_id, laterRun.stage_run_invocation_id);
    assert.equal(
      (firstRun.temporal_stage_run.family_runtime_stage_run as any).durable_launch.start_status,
      'started',
    );
    assert.equal(
      (replayRun.temporal_stage_run.family_runtime_stage_run as any).durable_launch.start_status,
      'started',
    );
    assert.equal(replayRun.output.sha256, firstRun.output.sha256);
    assert.equal(firstRun.hosted_runtime_binding_ref, v1Snapshot.provenance_ref);
    assert.equal(replayRun.hosted_runtime_binding_ref, v1Snapshot.provenance_ref);
    assert.equal(laterRun.hosted_runtime_binding_ref, v2Snapshot.provenance_ref);
    assert.equal(stageRuntimeCreateCalls, 2);
    assert.deepEqual(startedWorkflowIds.length, 2);
    assert.equal(new Set(startedWorkflowIds).size, 2);
    assert.equal(currentBindingResolutions, 2);
    assert.equal(pinnedBindingResolutions, 0);
  } finally {
    await host.dispose();
    if (previousStateRoot === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateRoot;
    fs.rmSync(checkoutRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('Hosted Stage action keeps started truth when query is unavailable and refreshes terminal replay', async () => {
  const checkoutRoot = root('opl-stage-action-query-failure-checkout-');
  const workspaceRoot = root('opl-stage-action-query-failure-workspace-');
  const ledgerStatuses: string[] = [];
  let attemptCalls = 0;
  let queryCalls = 0;
  try {
    writeContracts(checkoutRoot, [action({
      actionId: 'launch',
      executionBinding: { kind: 'stage_binding', stage_manifest_ref: 'agent/stages/manifest.json' },
      stageRoute: {
        entry_stage_ref: 'intake',
        required_stage_refs: ['intake'],
        optional_stage_refs: [],
        terminal_stage_refs: ['intake'],
        route_policy: 'ai_selected_progress_route',
      },
    })]);

    const result = await runStandardAgentAction({
      domainId: 'mas',
      actionId: 'launch',
      workspaceRoot,
      payload: { value: 3 },
      runId: 'stage-query-unavailable',
    }, {
      resolveManagedCheckout: managed(checkoutRoot, workspaceRoot) as never,
      compileStageManifest: (() => ({})) as never,
      recordLedger: ((input: Record<string, unknown>) => {
        ledgerStatuses.push(String(input.status));
        return recordLedger(input);
      }) as never,
      runStageRuntime: async (args) => {
        if (args[0] === 'attempt') {
          attemptCalls += 1;
          return {
            family_runtime_stage_run: {
              stage_run_input: { workflow_id: 'wf-stage-query-unavailable' },
              blocked_reason: null,
              temporal_start: { start_status: 'started' },
            },
          };
        }
        queryCalls += 1;
        throw new Error('temporal query temporarily unavailable');
      },
    });
    const replay = await runStandardAgentAction({
      domainId: 'mas',
      actionId: 'launch',
      workspaceRoot,
      payload: { value: 3 },
      runId: 'stage-query-unavailable',
    }, {
      resolveManagedCheckout: managed(checkoutRoot, workspaceRoot) as never,
      compileStageManifest: (() => ({})) as never,
      recordLedger,
      runStageRuntime: async (args) => {
        assert.deepEqual(args, ['stage-run', 'query', 'wf-stage-query-unavailable']);
        return { family_runtime_stage_run_query: { status: 'completed' } };
      },
    });
    const run = result.standard_agent_action_run;
    assert.equal(run.execution_kind, 'stage_binding');
    if (run.execution_kind !== 'stage_binding') assert.fail('expected stage action result');
    assert.equal(run.status, 'started');
    assert.deepEqual(ledgerStatuses, ['started']);
    assert.equal(run.temporal_stage_run_query, null);
    assert.deepEqual(run.temporal_stage_run_query_error, {
      error_code: 'standard_agent_action_observation_failed',
      message: 'temporal query temporarily unavailable',
    });
    const replayRun = replay.standard_agent_action_run;
    assert.equal(replayRun.execution_kind, 'stage_binding');
    if (replayRun.execution_kind !== 'stage_binding') assert.fail('expected Stage action replay');
    assert.equal(replayRun.output.sha256, run.output.sha256);
    assert.equal(replayRun.status, 'completed');
    assert.deepEqual(replayRun.temporal_stage_run_query, {
      family_runtime_stage_run_query: { status: 'completed' },
    });
    assert.equal(attemptCalls, 1);
    assert.equal(queryCalls, 1);
    const completion = inspectStandardAgentActionRunCompletion({
      workspaceRoot,
      runId: 'stage-query-unavailable',
    });
    assert.equal(completion?.status, 'started');
    assert.equal(completion?.failure_disposition, null);
  } finally {
    fs.rmSync(checkoutRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('Hosted Stage unknown-success retry reuses the frozen launch identity without persisting failure', async () => {
  const checkoutRoot = root('opl-stage-action-unknown-success-checkout-');
  const workspaceRoot = root('opl-stage-action-unknown-success-workspace-');
  const invocationIds: string[] = [];
  let attemptCalls = 0;
  let resolverCalls = 0;
  let compileCalls = 0;
  try {
    writeContracts(checkoutRoot, [action({
      actionId: 'launch',
      executionBinding: { kind: 'stage_binding', stage_manifest_ref: 'agent/stages/manifest.json' },
      stageRoute: {
        entry_stage_ref: 'intake',
        required_stage_refs: ['intake'],
        optional_stage_refs: [],
        terminal_stage_refs: ['intake'],
        route_policy: 'ai_selected_progress_route',
      },
    })]);
    const resolveG1 = managed(checkoutRoot, workspaceRoot);
    const dependencies = {
      resolveManagedCheckout: (async () => {
        resolverCalls += 1;
        return resolveG1();
      }) as never,
      compileStageManifest: (() => {
        compileCalls += 1;
        return {};
      }) as never,
      recordLedger,
      runStageRuntime: async (args: string[]) => {
        if (args[0] === 'attempt') {
          attemptCalls += 1;
          const invocationIndex = args.indexOf('--stage-run-invocation-id');
          invocationIds.push(args[invocationIndex + 1]);
          if (attemptCalls === 1) throw new Error('launch response timed out after acceptance');
          return {
            family_runtime_stage_run: {
              stage_run_input: { workflow_id: 'wf-stage-unknown-success' },
              blocked_reason: null,
              temporal_start: { start_status: 'reconciled' },
            },
          };
        }
        return { family_runtime_stage_run_query: { status: 'running' } };
      },
    };
    const request = {
      domainId: 'mas',
      actionId: 'launch',
      workspaceRoot,
      payload: { value: 17 },
      runId: 'stage-unknown-success',
    };
    await assert.rejects(
      runStandardAgentAction(request, dependencies),
      (error: unknown) => {
        const details = (error as { details?: Record<string, unknown> }).details;
        assert.equal(details?.failure_disposition, 'unknown_success');
        assert.equal(details?.same_run_retry_required, true);
        return true;
      },
    );
    assert.equal(
      inspectStandardAgentActionRunCompletion({ workspaceRoot, runId: request.runId }),
      null,
    );
    const binding = inspectStandardAgentActionRunBinding({ workspaceRoot, runId: request.runId });
    const plan = inspectStandardAgentActionRunPlan({ workspaceRoot, runId: request.runId });
    assert.equal(binding?.version, 'opl-standard-agent-action-run-binding.v2');
    assert.equal(plan?.execution_kind, 'stage_binding');
    assert.equal(plan?.catalog.actions[0]?.stage_route?.entry_stage_ref, 'intake');
    const stateDirectory = path.join(
      workspaceRoot,
      'control',
      'opl',
      'action_run_state',
      request.runId,
    );
    assert.deepEqual(fs.readdirSync(stateDirectory).sort(), ['binding.json', 'plan.json']);

    writeContracts(checkoutRoot, [action({
      actionId: 'launch',
      executionBinding: { kind: 'stage_binding', stage_manifest_ref: 'agent/stages/manifest.json' },
      stageRoute: {
        entry_stage_ref: 'review',
        required_stage_refs: ['review'],
        optional_stage_refs: [],
        terminal_stage_refs: ['review'],
        route_policy: 'ai_selected_progress_route',
      },
    })]);

    const retried = await runStandardAgentAction(request, dependencies);
    const run = retried.standard_agent_action_run;
    assert.equal(run.execution_kind, 'stage_binding');
    if (run.execution_kind !== 'stage_binding') assert.fail();
    assert.equal(run.status, 'started');
    assert.equal(run.stage_route.entry_stage_ref, 'intake');
    assert.equal(attemptCalls, 2);
    assert.equal(invocationIds.length, 2);
    assert.equal(invocationIds[1], invocationIds[0]);
    assert.equal(resolverCalls, 1);
    assert.equal(compileCalls, 1);
    const completion = inspectStandardAgentActionRunCompletion({
      workspaceRoot,
      runId: request.runId,
    });
    assert.equal(completion?.status, 'started');
    assert.equal(completion?.failure_disposition, null);

    const later = await runStandardAgentAction({ ...request, runId: 'stage-after-g2-drift' }, dependencies);
    const laterRun = later.standard_agent_action_run;
    assert.equal(laterRun.execution_kind, 'stage_binding');
    if (laterRun.execution_kind !== 'stage_binding') assert.fail();
    assert.equal(laterRun.stage_route.entry_stage_ref, 'review');
    assert.notEqual(laterRun.stage_run_invocation_id, invocationIds[0]);
    assert.equal(resolverCalls, 2);
    assert.equal(compileCalls, 2);
  } finally {
    fs.rmSync(checkoutRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
