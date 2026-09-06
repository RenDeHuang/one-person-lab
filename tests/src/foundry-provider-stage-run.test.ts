import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { canonicalJsonBytes } from '../../src/kernel/canonical-json.ts';
import { parseFamilyRuntimeCommand } from '../../src/adapters/execution/family-runtime-command.ts';
import { createCordisStageRouteComposition } from '../../src/host/plugins/cordis-agent-executor-experiment.ts';
import {
  FOUNDRY_PROTOCOL_VERSION,
  foundryContentDigest,
  normalizeFoundryProviderManifest,
  readFoundryProviderManifest,
  type AgentBlueprint,
  type FoundryProviderManifest,
  type FoundryActivityIdentity,
} from '../../src/authority/evolution/index.ts';
import {
  ContentAddressedCandidateCompiler,
  FileFoundryContentStore,
} from '../../src/authority/evidence/index.ts';
import {
  FileFoundryProviderArtifactReader,
  OplFoundryProviderStageRunGateway,
  StageRunFoundryProviderInvoker,
  type FoundryProviderStageRunGateway,
} from '../../src/adapters/execution/foundry-provider-stage-run.ts';

const provider: FoundryProviderManifest = {
  surface_kind: 'opl_foundry_provider',
  version: 'opl-foundry-provider.v1',
  provider_id: 'oma',
  agent_id: 'oma',
  package_id: 'oma',
  domain_id: 'agent_engineering',
  carrier_slug: 'opl-meta-agent',
  operations: {
    design: {
      input_schema_refs: ['opl://foundry-protocol/DesignRequest'],
      output_schema_ref: 'opl://foundry-protocol/AgentBlueprint',
      entry_stage_ref: 'mission-intake',
      required_stage_refs: ['mission-intake', 'evaluation-design'],
      optional_stage_refs: [],
      terminal_stage_ref: 'evaluation-design',
    },
    diagnose: {
      input_schema_refs: [
        'opl://foundry-protocol/DesignRequest',
        'opl://foundry-protocol/AgentBlueprint',
        'opl://foundry-protocol/EvidenceBundle',
      ],
      output_schema_ref: 'opl://foundry-protocol/EvolutionProposal',
      entry_stage_ref: 'evidence-diagnosis',
      required_stage_refs: ['evidence-diagnosis', 'evolution-proposal'],
      optional_stage_refs: [],
      terminal_stage_ref: 'evolution-proposal',
    },
  },
  projection_policy: {
    public_action_ids: ['engineer-fixture'],
    internal_operations_are_public_actions: false,
    internal_operations_are_cli_commands: false,
    internal_operations_are_mcp_tools: false,
  },
  authority_boundary: {
    provider_owns_design_semantics: true,
    provider_owns_evaluation_semantics: true,
    provider_owns_evidence_diagnosis: true,
    provider_owns_evolution_proposals: true,
    provider_owns_foundry_run_state: false,
    provider_owns_candidate_materialization: false,
    provider_owns_evaluation_execution: false,
    provider_owns_versions_or_activation: false,
    provider_can_return_patch_or_work_order: false,
    provider_can_view_protected_test_bodies: false,
    opl_can_write_target_domain_truth: false,
  },
};

for (const operation of ['design', 'diagnose'] as const) {
  test(`StageRun ${operation} binds declared output schemas and transport requirements before launch`, async (t) => {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-foundry-output-contract-'));
    t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
    const declaredProvider = structuredClone(provider);
    declaredProvider.provider_id = 'another-provider';
    declaredProvider.agent_id = 'another-provider';
    declaredProvider.package_id = 'another-provider';
    declaredProvider.operations[operation].terminal_stage_ref = 'custom-terminal';
    declaredProvider.operations[operation].required_stage_refs.push('custom-terminal');
    let captured: Record<string, any> | undefined;
    const launchBoundary = new Error('stop after capturing immutable launch inputs');
    const invoker = new StageRunFoundryProviderInvoker({
      storage_root: storageRoot,
      gateway: {
        async launch(input) {
          const bytes = fs.readFileSync(new URL(input.input_artifact_refs[0]!));
          assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), input.input_artifact_hashes[0]);
          captured = JSON.parse(bytes.toString('utf8'));
          throw launchBoundary;
        },
        async query() { throw new Error('not used'); },
      },
    });
    await assert.rejects(invoker.invoke({
      operation,
      provider: normalizeFoundryProviderManifest(declaredProvider),
      checkout_root: '/managed/another-provider',
      activity: { ...activity, phase: operation },
      payload: {} as never,
    }), (error) => error === launchBoundary);
    assert.ok(captured);
    const contract = captured.output_contract;
    assert.ok(contract, 'immutable provider input must include its output contract');
    assert.equal(contract.terminal_stage_ref, 'custom-terminal');
    assert.equal(contract.output_schema_ref, declaredProvider.operations[operation].output_schema_ref);
    assert.equal(contract.provider_manifest_digest, foundryContentDigest(declaredProvider));
    assert.equal(contract.schemas.length, operation === 'design' ? 1 : 2);
    for (const entry of contract.schemas) {
      assert.equal(entry.size_bytes, Buffer.byteLength(entry.content));
      assert.equal(entry.sha256, `sha256:${crypto.createHash('sha256').update(entry.content).digest('hex')}`);
      assert.equal(entry.content_ref, `opl-content://sha256/${entry.sha256.slice(7)}`);
      assert.equal(JSON.parse(entry.content).$id, entry.schema_id);
    }
    const blueprint = JSON.parse(contract.schemas.at(-1).content);
    assert.equal(blueprint.properties.surface_kind.const, 'opl_foundry_agent_blueprint');
    assert.equal(blueprint.additionalProperties, false);
    assert.ok(blueprint.$defs.eval_spec);
    assert.match(contract.transport_requirements.join('\n'), /exactly one raw JSON artifact/);
    assert.match(contract.transport_requirements.join('\n'), /immutable reviewer snapshot/);
  });
}

test('StageRun provider binds admitted source bytes to its actual initial launch', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-foundry-source-launch-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const bytes = Buffer.from('An arbitrary source body, transported exactly.\n');
  const content = new FileFoundryContentStore(storageRoot).put(bytes);
  const sourceRef = `source-material:${content.digest}`;
  const stopped = new Error('captured source launch');
  const invoker = new StageRunFoundryProviderInvoker({
    storage_root: storageRoot,
    gateway: {
      async launch(input) {
        assert.equal(input.input_artifact_refs.length, 2);
        const activityInput = JSON.parse(fs.readFileSync(new URL(input.input_artifact_refs[0]!), 'utf8'));
        assert.deepEqual(activityInput.source_artifacts, [{
          source_ref: sourceRef,
          ref: input.input_artifact_refs[1],
          sha256: input.input_artifact_hashes[1],
        }]);
        assert.equal(input.input_artifact_hashes[1], content.digest.slice(7));
        assert.deepEqual(fs.readFileSync(new URL(input.input_artifact_refs[1]!)), bytes);
        throw stopped;
      },
      async query() { throw new Error('not used'); },
    },
  });
  await assert.rejects(invoker.invoke({
    operation: 'design', provider, checkout_root: '/managed/provider', activity,
    payload: { request: { source_refs: [sourceRef] } as never },
  }), (error) => error === stopped);
});

test('StageRun provider rejects a report wrapping the raw terminal protocol object', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-foundry-output-wrapper-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const output = canonicalJsonBytes({
    surface_kind: 'stage_report',
    blueprint: { surface_kind: 'opl_foundry_agent_blueprint' },
  });
  const invoker = new StageRunFoundryProviderInvoker({
    storage_root: storageRoot,
    gateway: {
      async launch() { return { workflow_id: 'workflow:mission-intake' }; },
      async query(workflowId) {
        return workflowId === 'workflow:mission-intake'
          ? state({ stage: 'mission-intake', next: 'workflow:evaluation-design' })
          : state({
              stage: 'evaluation-design',
              refs: ['memory://wrapped-output'],
              hashes: [crypto.createHash('sha256').update(output).digest('hex')],
            });
      },
    },
    artifact_reader: { readExact: () => output },
  });
  await assert.rejects(invoker.invoke({
    operation: 'design',
    provider,
    checkout_root: '/managed/oma',
    payload: { request: { marker: 'request' } as never },
    activity,
  }), /exactly one schema-targeted raw output artifact/);
});

const activity: FoundryActivityIdentity = {
  run_id: 'run:provider-stage-test',
  iteration: 0,
  phase: 'design',
  input_digest: `sha256:${'1'.repeat(64)}`,
};

test('StageRun gateway uses the provider-declared public action instead of an OMA-specific constant', async () => {
  let args: string[] = [];
  const gateway = new OplFoundryProviderStageRunGateway((async (input: string[]) => {
    args = input;
    const command = parseFamilyRuntimeCommand(input);
    assert.equal(command.mode, 'attempt_create');
    if (command.mode !== 'attempt_create') throw new Error('Expected attempt_create');
    assert.equal(command.input.taskId, activity.run_id);
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
    workspace_root: '/managed/workspace',
    stage_id: 'mission-intake',
    stage_run_invocation_id: 'sri:provider-action',
    activity,
    input_artifact_refs: ['opl://foundry/input'],
    input_artifact_hashes: [`sha256:${'2'.repeat(64)}`],
  });
  assert.equal(args[args.indexOf('--action') + 1], 'engineer-fixture');
});

test('StageRun gateway forwards the Host Stagecraft composition to the runtime boundary', async () => {
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
  }) as typeof import('../../src/adapters/execution/family-runtime.ts').runFamilyRuntime, {
    create_stage_route_composition: createCordisStageRouteComposition,
  });
  await gateway.launch({
    provider,
    checkout_root: '/managed/provider',
    workspace_root: '/managed/workspace',
    stage_id: 'mission-intake',
    stage_run_invocation_id: 'sri:composition',
    activity,
    input_artifact_refs: [],
    input_artifact_hashes: [],
  });
  assert.equal(composed, true);
});

test('Foundry provider manifest rejects every unknown field and contradictory authority at intake', async (t) => {
  const cases: Array<{
    name: string;
    mutate: (manifest: Record<string, any>) => void;
    error: RegExp;
  }> = [
    {
      name: 'root field',
      mutate: (manifest) => { manifest.unknown_root = true; },
      error: /manifest root fields/i,
    },
    {
      name: 'extra evaluate operation',
      mutate: (manifest) => { manifest.operations.evaluate = structuredClone(manifest.operations.design); },
      error: /operations fields/i,
    },
    {
      name: 'design operation field',
      mutate: (manifest) => { manifest.operations.design.unknown_binding = 'stage:unknown'; },
      error: /design operation fields/i,
    },
    {
      name: 'diagnose operation field',
      mutate: (manifest) => { manifest.operations.diagnose.unknown_binding = 'stage:unknown'; },
      error: /diagnose operation fields/i,
    },
    {
      name: 'projection policy field',
      mutate: (manifest) => { manifest.projection_policy.public_internal_alias = true; },
      error: /projection_policy fields/i,
    },
    {
      name: 'authority boundary field',
      mutate: (manifest) => { manifest.authority_boundary.provider_owns_runtime = true; },
      error: /authority_boundary fields/i,
    },
    {
      name: 'contradictory authority',
      mutate: (manifest) => { manifest.authority_boundary.provider_owns_foundry_run_state = true; },
      error: /takes OPL runtime authority/i,
    },
    {
      name: 'required Stage duplicate',
      mutate: (manifest) => { manifest.operations.design.required_stage_refs.push('mission-intake'); },
      error: /invalid closed Stage topology/i,
    },
    {
      name: 'entry Stage outside first required position',
      mutate: (manifest) => { manifest.operations.design.entry_stage_ref = 'evaluation-design'; },
      error: /invalid closed Stage topology/i,
    },
    {
      name: 'terminal Stage outside final required position',
      mutate: (manifest) => { manifest.operations.design.terminal_stage_ref = 'mission-intake'; },
      error: /invalid closed Stage topology/i,
    },
    {
      name: 'required and optional Stage overlap',
      mutate: (manifest) => { manifest.operations.design.optional_stage_refs.push('mission-intake'); },
      error: /invalid closed Stage topology/i,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const checkoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-foundry-provider-closed-'));
      t.after(() => fs.rmSync(checkoutRoot, { recursive: true, force: true }));
      const manifest = structuredClone(provider) as unknown as Record<string, any>;
      scenario.mutate(manifest);
      const manifestFile = path.join(checkoutRoot, 'contracts/foundry_provider.json');
      fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
      fs.writeFileSync(manifestFile, canonicalJsonBytes(manifest));
      assert.throws(() => readFoundryProviderManifest(checkoutRoot), scenario.error);
    });
  }
});

function state(input: {
  stage: string;
  status?: string;
  next?: string | null;
  refs?: string[];
  hashes?: string[];
  currentRole?: string | null;
  attempts?: Array<Record<string, unknown>>;
  blockedReason?: string | null;
}) {
  return {
    surface_kind: 'temporal_stage_run_query',
    provider_kind: 'temporal',
    stage_run_id: `stage-run:${input.stage}`,
    workflow_id: `workflow:${input.stage}`,
    stage_id: input.stage,
    status: input.status ?? 'completed',
    artifact_refs: input.refs ?? [],
    artifact_hashes: input.hashes ?? [],
    next_stage_run_launch: input.next
      ? { target_workflow_id: input.next }
      : null,
    current_role: input.currentRole ?? null,
    attempts: input.attempts ?? [],
    blocked_reason: input.blockedReason ?? null,
    hard_stop_class: null,
    updated_at: new Date().toISOString(),
  };
}

const CONTENT_KINDS = ['prompt', 'skill', 'knowledge', 'helper', 'model', 'tool', 'schema'] as const;

function sha256(bytes: Buffer) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function providerResourceBytes(kind: typeof CONTENT_KINDS[number], label: string) {
  if (kind === 'schema') {
    return canonicalJsonBytes({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        request: { type: 'string' },
      },
      required: ['request'],
      additionalProperties: false,
    });
  }
  return Buffer.from(`${kind} ${label}\n`);
}

function writeProviderArtifact(root: string, name: string, bytes: Buffer) {
  const directory = path.join(root, 'provider-outputs');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  const digest = sha256(bytes);
  return {
    bytes,
    ref: pathToFileURL(file).href,
    sha256: `sha256:${digest}`,
    content_ref: `opl-content://sha256/${digest}`,
  };
}

function transportBlueprint(
  resources: Record<typeof CONTENT_KINDS[number], ReturnType<typeof writeProviderArtifact>>,
): AgentBlueprint {
  return {
    surface_kind: 'opl_foundry_agent_blueprint',
    version: FOUNDRY_PROTOCOL_VERSION,
    blueprint_id: 'blueprint:provider-transport-fixture',
    target_agent_id: 'provider-transport-agent',
    target_domain_id: 'provider_transport_domain',
    target_version_ref: null,
    design_request_digest: `sha256:${'1'.repeat(64)}`,
    generation: 0,
    stage_graph: {
      entry_stage_id: 'deliver',
      stages: [{
        stage_id: 'deliver',
        stage_kind: 'domain_delivery',
        goal: 'Deliver the provider transport fixture.',
        input_artifact_types: ['request'],
        output_artifact_types: ['delivery'],
        prompt_ref: resources.prompt.content_ref,
        skill_refs: [resources.skill.content_ref],
        knowledge_refs: [resources.knowledge.content_ref],
        capability_refs: ['capability:fixture'],
        next_stage_ids: [],
      }],
    },
    actions: [{
      action_id: 'deliver',
      summary: 'Deliver the provider transport fixture.',
      entry_stage_id: 'deliver',
      input_schema_ref: resources.schema.content_ref,
      output_schema_ref: resources.schema.content_ref,
    }],
    artifact_contracts: [{
      artifact_type: 'delivery',
      schema_ref: resources.schema.content_ref,
      authority_owner_ref: 'owner:fixture',
    }],
    content_refs: {
      prompt_refs: [resources.prompt.content_ref],
      skill_refs: [resources.skill.content_ref],
      knowledge_refs: [resources.knowledge.content_ref],
      helper_refs: [resources.helper.content_ref],
      model_refs: [resources.model.content_ref],
      tool_refs: [resources.tool.content_ref],
      schema_refs: [resources.schema.content_ref],
    },
    capability_requirements: ['capability:fixture'],
    authority_policy: {
      truth_owner_ref: 'owner:fixture',
      artifact_owner_ref: 'owner:fixture',
      quality_owner_ref: 'owner:fixture',
      permission_refs: [],
      generated_agent_can_modify_versions: false,
      generated_agent_can_modify_evaluation: false,
      generated_agent_can_modify_permissions: false,
      generated_agent_can_modify_activation: false,
    },
    memory_policy: {
      memory_classes: [],
      retention_refs: [],
      write_authority_refs: [],
    },
    assumptions: [],
    design_evidence_refs: [],
    eval_spec: {
      eval_spec_id: 'eval:provider-transport-fixture',
      public_cases: [{ case_id: 'case:fixture', test_ref: 'test:fixture', weight: 1, required: true }],
      protected_requirements: [{ category: 'protected-fixture', minimum_case_count: 1 }],
      gates: [{ gate_id: 'gate:fixture', metric: 'score', operator: 'gte', threshold: 1, required: true }],
      baseline_comparison: { required: false, regression_tolerance: 0 },
      independent_evaluator_required: true,
    },
    risk_hint: 'low',
  };
}

test('StageRun provider invocation follows declared Stages even when observation persistence fails', async (t) => {
  const output = canonicalJsonBytes({
    surface_kind: 'opl_foundry_agent_blueprint',
    marker: 'exact-terminal-output',
    content_refs: {
      prompt_refs: [],
      skill_refs: [],
      knowledge_refs: [],
      helper_refs: [],
      model_refs: [],
      tool_refs: [],
      schema_refs: [],
    },
  });
  const launches: Array<Parameters<FoundryProviderStageRunGateway['launch']>[0]> = [];
  const gateway: FoundryProviderStageRunGateway = {
    async launch(input) {
      launches.push(input);
      return { workflow_id: 'workflow:mission-intake' };
    },
    async query(workflowId) {
      return workflowId === 'workflow:mission-intake'
        ? state({ stage: 'mission-intake', next: 'workflow:evaluation-design' })
        : state({
            stage: 'evaluation-design',
            refs: ['memory://terminal-output'],
            hashes: [`${'a'.repeat(64)}`],
          });
    },
  };
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-foundry-provider-invoker-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(storageRoot, 'provider-observations'), 'not a directory');
  const invoker = new StageRunFoundryProviderInvoker({
    gateway,
    storage_root: storageRoot,
    poll_interval_ms: 1,
    timeout_ms: 100,
    artifact_reader: { readExact: () => output },
  });

  const result = await invoker.invoke({
    operation: 'design',
    provider,
    checkout_root: '/managed/oma',
    payload: { request: { marker: 'request' } as never },
    activity,
  });

  assert.equal((result as Record<string, unknown>).marker, 'exact-terminal-output');
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0]?.activity, activity);
  assert.equal(launches[0]?.stage_id, 'mission-intake');
  assert.equal(launches[0]?.input_artifact_refs.length, 1);
  assert.equal(launches[0]?.input_artifact_hashes.length, 1);
});

test('StageRun provider preserves observation history across retries and reports the failing attempt', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-foundry-provider-observations-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const gateway: FoundryProviderStageRunGateway = {
    async launch() {
      return { workflow_id: 'workflow:mission-intake' };
    },
    async query() {
      return state({
        stage: 'mission-intake',
        status: 'blocked',
        currentRole: null,
        blockedReason: 'codex_cli_provider_unavailable',
        attempts: [{
          attempt_role: 'producer',
          stage_attempt_id: 'sat_mission_intake_producer_0',
          status: 'blocked',
        }],
      });
    },
  };
  const invoker = new StageRunFoundryProviderInvoker({ gateway, storage_root: storageRoot });

  await assert.rejects(invoker.invoke({
    operation: 'design',
    provider,
    checkout_root: '/managed/oma',
    payload: { request: { marker: 'request' } as never },
    activity,
  }), (error: Error) => {
    assert.match(error.message, /codex_cli_provider_unavailable/);
    assert.match(error.message, /sat_mission_intake_producer_0/);
    assert.match(error.message, /observation_receipt_ref/);
    return true;
  });
  const receiptFile = path.join(
    storageRoot,
    'provider-observations',
    `${crypto.createHash('sha256').update(canonicalJsonBytes({
      run_id: activity.run_id,
      iteration: activity.iteration,
      phase: activity.phase,
      input_digest: activity.input_digest,
    })).digest('hex')}.json`,
  );
  assert.equal(fs.existsSync(receiptFile), true);
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')) as Record<string, any>;
  assert.equal(receipt.surface_kind, 'opl_foundry_provider_stage_run_observation_receipt');
  assert.equal(receipt.observations.length, 1);
  assert.equal(receipt.observations[0].stage_id, 'mission-intake');
  assert.equal(receipt.observations[0].attempt.stage_attempt_id, 'sat_mission_intake_producer_0');
  await assert.rejects(invoker.invoke({
    operation: 'design', provider, checkout_root: '/managed/oma',
    payload: { request: { marker: 'request' } as never }, activity,
  }));
  const retried = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  assert.deepEqual(retried.observations[0], receipt.observations[0]);
  assert.ok(retried.observations.length >= receipt.observations.length);
});

test('StageRun provider transports all seven exact content classes into a compiler-complete candidate', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-foundry-provider-seven-class-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const resources = Object.fromEntries(CONTENT_KINDS.map((kind) => [
    kind,
    writeProviderArtifact(storageRoot, `${kind}.blob`, providerResourceBytes(kind, 'provider bytes')),
  ])) as Record<typeof CONTENT_KINDS[number], ReturnType<typeof writeProviderArtifact>>;
  const blueprint = transportBlueprint(resources);
  const protocolArtifact = writeProviderArtifact(
    storageRoot,
    'agent-blueprint.json',
    canonicalJsonBytes(blueprint),
  );
  const terminalArtifacts = [protocolArtifact, ...CONTENT_KINDS.map((kind) => resources[kind])];
  const gateway: FoundryProviderStageRunGateway = {
    async launch() {
      return { workflow_id: 'workflow:mission-intake' };
    },
    async query(workflowId) {
      return workflowId === 'workflow:mission-intake'
        ? state({ stage: 'mission-intake', next: 'workflow:evaluation-design' })
        : state({
            stage: 'evaluation-design',
            refs: terminalArtifacts.map((entry) => entry.ref),
            hashes: terminalArtifacts.map((entry) => entry.sha256),
          });
    },
  };
  const invoker = new StageRunFoundryProviderInvoker({ gateway, storage_root: storageRoot });
  const transported = await invoker.invoke({
    operation: 'design',
    provider,
    checkout_root: '/managed/provider',
    payload: { request: { marker: 'request' } as never },
    activity,
  }) as AgentBlueprint;
  const compiler = new ContentAddressedCandidateCompiler(storageRoot);
  const candidate = await compiler.materialize({
    run_id: activity.run_id,
    blueprint: transported,
    blueprint_digest: foundryContentDigest(transported),
  });
  const lock = JSON.parse(fs.readFileSync(
    path.join(compiler.candidateDirectory(candidate.candidate_digest), 'contracts/resource-lock.json'),
    'utf8',
  )) as { resources: Array<{ kind: string; declared_ref: string; sha256: string }> };

  assert.deepEqual(lock.resources.map((entry) => entry.kind), CONTENT_KINDS);
  for (const kind of CONTENT_KINDS) {
    const binding = lock.resources.find((entry) => entry.kind === kind);
    assert.equal(binding?.declared_ref, resources[kind].content_ref);
    assert.equal(binding?.sha256, resources[kind].sha256);
  }
});

test('StageRun provider requires current terminal SHA transport even when exact resource bytes are cached', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-foundry-provider-current-transport-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const resources = Object.fromEntries(CONTENT_KINDS.map((kind) => [
    kind,
    writeProviderArtifact(storageRoot, `${kind}.blob`, providerResourceBytes(kind, 'cached transport bytes')),
  ])) as Record<typeof CONTENT_KINDS[number], ReturnType<typeof writeProviderArtifact>>;
  new FileFoundryContentStore(storageRoot).put(resources.model.bytes, resources.model.content_ref);
  const protocolArtifact = writeProviderArtifact(
    storageRoot,
    'agent-blueprint.json',
    canonicalJsonBytes(transportBlueprint(resources)),
  );
  const terminalArtifacts = [
    protocolArtifact,
    ...CONTENT_KINDS.filter((kind) => kind !== 'model').map((kind) => resources[kind]),
  ];
  const gateway: FoundryProviderStageRunGateway = {
    async launch() {
      return { workflow_id: 'workflow:mission-intake' };
    },
    async query(workflowId) {
      return workflowId === 'workflow:mission-intake'
        ? state({ stage: 'mission-intake', next: 'workflow:evaluation-design' })
        : state({
            stage: 'evaluation-design',
            refs: terminalArtifacts.map((entry) => entry.ref),
            hashes: terminalArtifacts.map((entry) => entry.sha256),
          });
    },
  };
  const invoker = new StageRunFoundryProviderInvoker({ gateway, storage_root: storageRoot });

  await assert.rejects(invoker.invoke({
    operation: 'design',
    provider,
    checkout_root: '/managed/provider',
    payload: { request: { marker: 'request' } as never },
    activity,
  }), /did not transport bytes for a content-addressed AgentBlueprint ref/);
});

test('StageRun provider invocation fails closed when a required semantic Stage is skipped', async () => {
  const gateway: FoundryProviderStageRunGateway = {
    async launch() {
      return { workflow_id: 'workflow:evaluation-design' };
    },
    async query() {
      return state({
        stage: 'evaluation-design',
        refs: ['memory://terminal-output'],
        hashes: [`${'b'.repeat(64)}`],
      });
    },
  };
  const invoker = new StageRunFoundryProviderInvoker({
    gateway,
    storage_root: fs.mkdtempSync(path.join(os.tmpdir(), 'opl-foundry-provider-skip-')),
    artifact_reader: {
      readExact: () => canonicalJsonBytes({ surface_kind: 'opl_foundry_agent_blueprint' }),
    },
  });

  await assert.rejects(invoker.invoke({
    operation: 'design',
    provider,
    checkout_root: '/managed/oma',
    payload: { request: { marker: 'request' } as never },
    activity,
  }), /skipped required semantic Stages/);
});

test('Foundry provider artifact reader rejects symlinks and hash mismatches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-foundry-provider-artifact-'));
  const file = path.join(root, 'output.json');
  fs.writeFileSync(file, '{}\n', 'utf8');
  const link = path.join(root, 'output-link.json');
  fs.symlinkSync(file, link);
  const reader = new FileFoundryProviderArtifactReader({ allowed_root: root });

  assert.throws(() => reader.readExact({
    ref: pathToFileURL(file).href,
    sha256: `${'0'.repeat(64)}`,
  }), /do not match/);
  assert.throws(() => reader.readExact({
    ref: pathToFileURL(link).href,
    sha256: `${'0'.repeat(64)}`,
  }), /outside the allowed immutable transport boundary/);
});

test('default provider transport cannot read artifacts outside the Foundry storage root', async (t) => {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-foundry-provider-root-'));
  t.after(() => fs.rmSync(container, { recursive: true, force: true }));
  const storageRoot = path.join(container, 'foundry');
  fs.mkdirSync(storageRoot);
  const outside = path.join(container, 'outside.json');
  const bytes = canonicalJsonBytes({ surface_kind: 'opl_foundry_agent_blueprint' });
  fs.writeFileSync(outside, bytes);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const gateway: FoundryProviderStageRunGateway = {
    async launch() {
      return { workflow_id: 'workflow:mission-intake' };
    },
    async query(workflowId) {
      return workflowId === 'workflow:mission-intake'
        ? state({ stage: 'mission-intake', next: 'workflow:evaluation-design' })
        : state({
            stage: 'evaluation-design',
            refs: [pathToFileURL(outside).href],
            hashes: [hash],
          });
    },
  };
  const invoker = new StageRunFoundryProviderInvoker({ gateway, storage_root: storageRoot });
  await assert.rejects(invoker.invoke({
    operation: 'design',
    provider,
    checkout_root: '/managed/provider',
    payload: { request: { marker: 'request' } as never },
    activity,
  }), /outside the allowed immutable transport boundary/);
});
