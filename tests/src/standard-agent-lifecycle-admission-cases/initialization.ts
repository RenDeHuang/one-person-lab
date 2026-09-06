import {
  assert,
  canonicalJsonBytes,
  fs,
  fileURLToPath,
  path,
  test,
  digest,
  initializationAuthorityHandler,
  inspectStandardAgentActionRunBinding,
  inspectStandardAgentActionRunPlan,
  nativeManagedCheckout,
  preflightStandardAgentDomainLifecycleAdmission,
  runStandardAgentAction,
  runStandardAgentHandlerSandbox,
  standardAgentLifecycleInitializationHandlerRunId,
  temporaryRoot,
  writeIdentityOnlyLifecycleWorkspace,
  writeJson,
  writeLifecycleContracts,
  writeLifecycleWorkspace,
  writeNativeCarrierDescriptor,
} from './shared.ts';

test('ordinary research admission is independent of quality and publication permission', () => {
  const fixtureRoot = temporaryRoot('opl-progress-first-admission-');
  const checkoutRoot = path.join(fixtureRoot, 'checkout');
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  try {
    fs.mkdirSync(checkoutRoot, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    writeLifecycleContracts(checkoutRoot);
    const refs = writeLifecycleWorkspace(workspaceRoot);
    const catalog = JSON.parse(fs.readFileSync(path.join(checkoutRoot, 'contracts/action_catalog.json'), 'utf8'));
    const lifecyclePath = fileURLToPath(refs.lifecycle.ref);
    const lifecycle = JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'));
    const admit = () => preflightStandardAgentDomainLifecycleAdmission({
      action: catalog.actions[0], payload: { study_id: 'study-001' },
      checkoutRoot, workspaceRoot, domainId: 'mas', runId: 'progress-first',
      originalInvocationSha256: 'a'.repeat(64),
    });
    for (const qualityStatus of ['unknown', 'insufficient']) {
      writeJson(lifecyclePath, {
        ...lifecycle, lifecycle_state: 'active', quality_status: qualityStatus,
        authority_boundary: {
          stage_body_authorized: true, business_action_authorized: true,
          publication_authorized: false, submission_authorized: false,
        },
      });
      assert.equal(admit().status, 'admitted_by_canonical_active_lifecycle');
    }
    for (const restriction of [
      { qualification_only: true },
      { business_status: 'qualification_only' },
      { authority_boundary: { stage_body_authorized: false } },
      { authority_boundary: { business_action_authorized: false } },
    ]) {
      writeJson(lifecyclePath, { ...lifecycle, lifecycle_state: 'active', ...restriction });
      assert.throws(admit, /cannot authorize an ordinary Stage or business route/u);
    }
    writeJson(lifecyclePath, { ...lifecycle, lifecycle_state: 'stopped' });
    assert.throws(admit, /inactive/u);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function stageDependencies(input: {
  checkoutRoot: string;
  workspaceRoot: string;
  runHandler: ReturnType<typeof initializationAuthorityHandler>;
  onAttempt: () => void;
}) {
  return {
    resolveManagedCheckout: async () => ({
      ...nativeManagedCheckout(input.checkoutRoot, input.workspaceRoot),
    }) as never,
    compileStageManifest: (() => ({})) as never,
    recordLedger: ((value: Record<string, unknown>) => ({
      ledger_entry: { run_id: value.runId, status: value.status },
      recorded_event: { event_type: 'standard_agent_action_run_recorded' },
    })) as never,
    runHandler: input.runHandler as never,
    runStageRuntime: async (args: string[]) => {
      if (args[0] === 'attempt') {
        input.onAttempt();
        return {
          family_runtime_stage_run: {
            stage_run_input: { workflow_id: 'wf-initialized-stage' },
            blocked_reason: null,
            temporal_start: { start_status: 'started' },
          },
        };
      }
      return { family_runtime_stage_run_query: { status: 'running' } };
    },
  };
}

function writeWorkspaceRegistryBinding(stateRoot: string, workspaceRoot: string) {
  writeJson(path.join(stateRoot, 'workspace-registry.json'), {
    version: 'g2',
    bindings: [{
      binding_id: `binding-${path.basename(workspaceRoot)}`,
      project_scope_id: `project-scope-${path.basename(workspaceRoot)}`,
      project_id: 'medautoscience',
      project: 'mas',
      workspace_path: fs.realpathSync.native(workspaceRoot),
      label: null,
      status: 'active',
      direct_entry: { command: null, manifest_command: null, url: null, workspace_locator: null },
      created_at: '2026-08-26T00:00:00.000Z',
      updated_at: '2026-08-26T00:00:00.000Z',
      archived_at: null,
    }],
  });
}

test('real MAS catalog, schemas and sandboxed handler initialize an identity-only study', {
  skip: !process.env.OPL_REAL_MAS_REPO,
}, async () => {
  const checkoutRoot = fs.realpathSync.native(process.env.OPL_REAL_MAS_REPO!);
  const fixtureRoot = temporaryRoot('opl-mas-initialization-abi-');
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  const stateRoot = path.join(fixtureRoot, 'state');
  const previousStateRoot = process.env.OPL_STATE_DIR;
  let handlerCalls = 0;
  let attemptCalls = 0;
  try {
    process.env.OPL_STATE_DIR = stateRoot;
    fs.mkdirSync(path.join(workspaceRoot, 'studies/study-001'), { recursive: true });
    writeJson(path.join(workspaceRoot, 'workspace_index.json'), {
      surface_kind: 'opl_workspace_index', version: 'workspace-index.v1',
      studies: [{
        study_id: 'study-001', canonical_study_root: 'studies/study-001',
        quality_status: 'insufficient',
      }],
    });
    writeWorkspaceRegistryBinding(stateRoot, workspaceRoot);
    const dependencies = {
      ...stageDependencies({
        checkoutRoot, workspaceRoot,
        runHandler: ((request: Parameters<typeof runStandardAgentHandlerSandbox>[0]) => {
          handlerCalls += 1;
          return runStandardAgentHandlerSandbox(request);
        }) as never,
        onAttempt: () => { attemptCalls += 1; },
      }),
      compileStageManifest: undefined,
    };
    const input = {
      domainId: 'mas', actionId: 'direction_and_route_selection', workspaceRoot,
      payload: { study_id: 'study-001', user_intent: 'Draft a research question; quality remains unassessed.' },
      runId: 'real-mas-initialization',
    };
    const result = await runStandardAgentAction(input, dependencies);
    if (result.standard_agent_action_run.execution_kind !== 'stage_binding') {
      assert.fail('expected a Stage action after real MAS initialization');
    }
    assert.equal(result.standard_agent_action_run.domain_lifecycle_admission.status,
      'admitted_by_current_initialization_receipt');
    const lifecyclePath = path.join(workspaceRoot, 'studies/study-001/control/lifecycle.json');
    const lifecycleBytes = fs.readFileSync(lifecyclePath);
    const lifecycle = JSON.parse(lifecycleBytes.toString('utf8'));
    assert.equal(lifecycle.lifecycle_state, 'active');
    assert.equal(lifecycle.generation, 1);
    assert.equal(lifecycle.submission_ready, false);
    const inventory = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'workspace_index.json'), 'utf8'));
    assert.equal(inventory.studies[0].quality_status, 'insufficient');
    assert.equal(inventory.studies[0].lifecycle_ref, 'control/lifecycle.json');
    const receipt = JSON.parse(fs.readFileSync(
      path.join(workspaceRoot, inventory.studies[0].initialization_receipt_ref), 'utf8',
    ));
    assert.equal(receipt.stage_body_authorized, true);
    assert.equal(receipt.publication_authorized, false);
    assert.equal(receipt.submission_authorized, false);
    assert.equal(receipt.quality_verdict_created, false);
    await runStandardAgentAction(input, dependencies);
    assert.deepEqual(fs.readFileSync(lifecyclePath), lifecycleBytes);
    assert.equal(handlerCalls, 1);
    assert.equal(attemptCalls, 1);
  } finally {
    if (previousStateRoot === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateRoot;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('identity-only work item is owner-initialized before Stage launch and freezes the post-CAS scope', async () => {
  const fixtureRoot = temporaryRoot('opl-lifecycle-initialization-');
  const checkoutRoot = path.join(fixtureRoot, 'checkout');
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  const stateRoot = path.join(fixtureRoot, 'state');
  const previousStateRoot = process.env.OPL_STATE_DIR;
  let handlerCalls = 0;
  let attemptCalls = 0;
  try {
    fs.mkdirSync(checkoutRoot, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    process.env.OPL_STATE_DIR = stateRoot;
    writeLifecycleContracts(checkoutRoot);
    writeNativeCarrierDescriptor(checkoutRoot);
    writeIdentityOnlyLifecycleWorkspace(workspaceRoot);
    writeWorkspaceRegistryBinding(stateRoot, workspaceRoot);
    const payload = { study_id: 'study-001', value: 1 };
    const runId = 'initialized-stage';
    const invocationSha256 = digest(canonicalJsonBytes({
      canonical_domain_id: 'mas',
      action_id: 'launch_stage',
      run_id: runId,
      workspace_root: fs.realpathSync.native(workspaceRoot),
      request_payload_sha256: digest(canonicalJsonBytes(payload)),
      timeout_ms: null,
    }));
    const childRunId = standardAgentLifecycleInitializationHandlerRunId({
      domainId: 'mas',
      actionId: 'launch_stage',
      runId,
      workItemId: 'study-001',
      originalInvocationSha256: invocationSha256,
    });
    const result = await runStandardAgentAction({
      domainId: 'mas', actionId: 'launch_stage', workspaceRoot, payload, runId,
    }, stageDependencies({
      checkoutRoot,
      workspaceRoot,
      runHandler: initializationAuthorityHandler(workspaceRoot, () => { handlerCalls += 1; }),
      onAttempt: () => { attemptCalls += 1; },
    }));

    assert.equal(result.standard_agent_action_run.execution_kind, 'stage_binding');
    if (result.standard_agent_action_run.execution_kind !== 'stage_binding') {
      assert.fail('expected initialized Stage action result');
    }
    assert.equal(result.standard_agent_action_run.domain_lifecycle_admission.status,
      'admitted_by_current_initialization_receipt');
    assert.equal(handlerCalls, 1);
    assert.equal(attemptCalls, 1);
    const lifecycle = JSON.parse(fs.readFileSync(
      path.join(workspaceRoot, 'studies', 'study-001', 'control', 'lifecycle.json'),
      'utf8',
    ));
    assert.equal(lifecycle.lifecycle_state, 'active');
    assert.equal(lifecycle.lifecycle_generation, 1);
    const inventory = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'workspace_index.json'), 'utf8'));
    assert.equal(inventory.studies[0].lifecycle_ref, 'control/lifecycle.json');
    const childPlan = inspectStandardAgentActionRunPlan({ workspaceRoot, runId: childRunId });
    const parentPlan = inspectStandardAgentActionRunPlan({ workspaceRoot, runId });
    const frozenAdmission = parentPlan?.effective_payload?.lifecycle_admission as Record<string, unknown>;
    assert.equal(frozenAdmission.mode, 'initialization_receipt');
    assert.notEqual(parentPlan?.execution_scope?.inventory_digest, childPlan?.execution_scope?.inventory_digest);
    assert.equal(parentPlan?.execution_scope?.inventory_digest,
      result.standard_agent_action_run.execution_scope?.inventory_digest);
  } finally {
    if (previousStateRoot === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateRoot;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('existing lifecycle never enters initialization authority', async () => {
  const fixtureRoot = temporaryRoot('opl-lifecycle-existing-');
  const checkoutRoot = path.join(fixtureRoot, 'checkout');
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  const stateRoot = path.join(fixtureRoot, 'state');
  const previousStateRoot = process.env.OPL_STATE_DIR;
  let handlerCalls = 0;
  let attemptCalls = 0;
  try {
    fs.mkdirSync(checkoutRoot, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    process.env.OPL_STATE_DIR = stateRoot;
    writeLifecycleContracts(checkoutRoot);
    writeNativeCarrierDescriptor(checkoutRoot);
    writeLifecycleWorkspace(workspaceRoot);
    writeWorkspaceRegistryBinding(stateRoot, workspaceRoot);
    writeJson(path.join(workspaceRoot, 'studies', '001', 'control', 'lifecycle.json'), {
      study_id: 'study-001', lifecycle_state: 'active', lifecycle_generation: 7,
    });
    const inventory = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'workspace_index.json'), 'utf8'));
    inventory.studies[0].status = 'active';
    writeJson(path.join(workspaceRoot, 'workspace_index.json'), inventory);
    const result = await runStandardAgentAction({
      domainId: 'mas', actionId: 'launch_stage', workspaceRoot,
      payload: { study_id: 'study-001', value: 1 }, runId: 'existing-active-stage',
    }, stageDependencies({
      checkoutRoot,
      workspaceRoot,
      runHandler: initializationAuthorityHandler(workspaceRoot, () => { handlerCalls += 1; }),
      onAttempt: () => { attemptCalls += 1; },
    }));
    assert.equal(result.standard_agent_action_run.execution_kind, 'stage_binding');
    if (result.standard_agent_action_run.execution_kind !== 'stage_binding') {
      assert.fail('expected existing-lifecycle Stage action result');
    }
    assert.equal(result.standard_agent_action_run.domain_lifecycle_admission.status,
      'admitted_by_canonical_active_lifecycle');
    assert.equal(handlerCalls, 0);
    assert.equal(attemptCalls, 1);
  } finally {
    if (previousStateRoot === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateRoot;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('identity-only initialization fails closed when inventory CAS becomes stale', async () => {
  const fixtureRoot = temporaryRoot('opl-lifecycle-initialization-stale-');
  const checkoutRoot = path.join(fixtureRoot, 'checkout');
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  const stateRoot = path.join(fixtureRoot, 'state');
  const previousStateRoot = process.env.OPL_STATE_DIR;
  let attemptCalls = 0;
  try {
    fs.mkdirSync(checkoutRoot, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    process.env.OPL_STATE_DIR = stateRoot;
    writeLifecycleContracts(checkoutRoot);
    writeNativeCarrierDescriptor(checkoutRoot);
    writeIdentityOnlyLifecycleWorkspace(workspaceRoot);
    writeWorkspaceRegistryBinding(stateRoot, workspaceRoot);
    const baseHandler = initializationAuthorityHandler(workspaceRoot, () => {});
    const staleHandler = (input: { request: unknown }) => {
      const receipt = baseHandler(input);
      writeJson(path.join(workspaceRoot, 'workspace_index.json'), {
        studies: [{ study_id: 'study-001', study_root: 'studies/study-001', concurrent_marker: true }],
      });
      return receipt;
    };
    const runId = 'stale-initialization-stage';
    await assert.rejects(runStandardAgentAction({
      domainId: 'mas', actionId: 'launch_stage', workspaceRoot,
      payload: { study_id: 'study-001', value: 1 }, runId,
    }, stageDependencies({
      checkoutRoot,
      workspaceRoot,
      runHandler: staleHandler as never,
      onAttempt: () => { attemptCalls += 1; },
    })), /precondition|current exact bytes|CAS/u);
    assert.equal(attemptCalls, 0);
    assert.equal(inspectStandardAgentActionRunBinding({ workspaceRoot, runId }), null);
    assert.equal(fs.existsSync(path.join(
      workspaceRoot, 'studies', 'study-001', 'control', 'lifecycle.json',
    )), false);
  } finally {
    if (previousStateRoot === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateRoot;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
