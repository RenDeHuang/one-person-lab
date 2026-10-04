import {
  assert,
  fs,
  path,
  test,
  fileURLToPath,
  createCordisBaseHeadlessComposition,
  observeDomainArtifactCasMaterialization,
  nativeCarrierReadiness,
  packageUseBinding,
  preflightFamilyRuntimeDomainLifecycleAdmission,
  preflightStandardAgentDomainLifecycleAdmission,
  runFamilyRuntime,
  temporaryRoot,
  writeJson,
  writeLifecycleCasReadState,
  writeLifecycleContracts,
  writeLifecycleWorkspace,
} from '../shared.ts';

test('family runtime lifecycle preflight fails closed on inactive and unresolved MAS launch identity', () => {
  const fixtureRoot = temporaryRoot('opl-family-lifecycle-preflight-');
  const checkoutRoot = path.join(fixtureRoot, 'checkout');
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  const previousStateRoot = process.env.OPL_STATE_DIR;
  try {
    process.env.OPL_STATE_DIR = path.join(fixtureRoot, 'state');
    fs.mkdirSync(checkoutRoot, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    writeLifecycleContracts(checkoutRoot);
    const refs = writeLifecycleWorkspace(workspaceRoot);
    const launch = {
      domainId: 'mas',
      stageId: 'intake',
      actionId: 'launch_stage',
      domainPackRoot: checkoutRoot,
      workspaceLocator: { workspace_root: workspaceRoot, study_id: 'study-001' },
    };

    assert.throws(
      () => preflightFamilyRuntimeDomainLifecycleAdmission(launch),
      /lifecycle is inactive/i,
    );
    assert.throws(
      () => preflightFamilyRuntimeDomainLifecycleAdmission({
        ...launch,
        domainPackRoot: null,
      }),
      /missing its pinned domain pack checkout/i,
    );
    const missingCatalogRoot = path.join(fixtureRoot, 'missing-catalog');
    fs.mkdirSync(missingCatalogRoot);
    assert.throws(
      () => preflightFamilyRuntimeDomainLifecycleAdmission({
        ...launch,
        domainPackRoot: missingCatalogRoot,
      }),
      /missing its authoritative action catalog/i,
    );
    assert.throws(
      () => preflightFamilyRuntimeDomainLifecycleAdmission({
        ...launch,
        actionId: 'stale-action-id',
      }),
      /action identity is not declared|cannot resolve the requested action/i,
    );
    assert.throws(
      () => preflightFamilyRuntimeDomainLifecycleAdmission({
        ...launch,
        actionId: 'reactivate_study',
      }),
      /does not declare the requested lifecycle-gated Stage/i,
    );

    writeJson(fileURLToPath(refs.lifecycle.ref), {
      study_id: 'study-001', lifecycle_state: 'active', lifecycle_generation: 8,
    });
    const admitted = preflightFamilyRuntimeDomainLifecycleAdmission(launch);
    assert.equal(admitted.status, 'admitted_by_canonical_active_lifecycle');
    assert.equal(admitted.lifecycle_generation, 8);
    assert.equal(admitted.domain_artifact_cas_read_guard.status, 'settled_stable');

    writeJson(fileURLToPath(refs.lifecycle.ref), {
      study_id: 'study-001',
      lifecycle_state: 'active',
      lifecycle_generation: 9,
      business_status: 'qualification_only',
      qualification_only: true,
      stage_body_authorized: false,
      business_action_authorized: false,
      publication_authorized: false,
      submission_authorized: false,
    });
    const qualificationCatalog = JSON.parse(fs.readFileSync(
      path.join(checkoutRoot, 'contracts', 'action_catalog.json'),
      'utf8',
    ));
    assert.throws(
      () => preflightStandardAgentDomainLifecycleAdmission({
        action: qualificationCatalog.actions[0],
        payload: { study_id: 'study-001' },
        checkoutRoot,
        workspaceRoot,
        domainId: 'mas',
        runId: 'qualification-only-standard-preflight',
        originalInvocationSha256: 'a'.repeat(64),
      }),
      /qualification-only lifecycle cannot authorize/i,
    );
    assert.throws(
      () => preflightFamilyRuntimeDomainLifecycleAdmission(launch),
      /qualification-only lifecycle cannot authorize/i,
    );
    writeJson(fileURLToPath(refs.lifecycle.ref), {
      study_id: 'study-001',
      lifecycle_state: 'active',
      lifecycle_generation: 10,
      stage_body_authorized: false,
    });
    assert.throws(
      () => preflightStandardAgentDomainLifecycleAdmission({
        action: qualificationCatalog.actions[0],
        payload: { study_id: 'study-001' },
        checkoutRoot,
        workspaceRoot,
        domainId: 'mas',
        runId: 'deny-only-standard-preflight',
        originalInvocationSha256: 'b'.repeat(64),
      }),
      /qualification-only lifecycle cannot authorize/i,
    );
    assert.throws(
      () => preflightFamilyRuntimeDomainLifecycleAdmission(launch),
      /qualification-only lifecycle cannot authorize/i,
    );
    writeJson(fileURLToPath(refs.lifecycle.ref), {
      study_id: 'study-001', lifecycle_state: 'active', lifecycle_generation: 11,
    });

    const stableCas = observeDomainArtifactCasMaterialization({ workspaceRoot });
    let observationCount = 0;
    assert.throws(
      () => preflightFamilyRuntimeDomainLifecycleAdmission(launch, {
        observeDomainArtifactCas: () => ({
          ...stableCas,
          observed_generation: observationCount++ === 0
            ? `sha256:${'1'.repeat(64)}`
            : `sha256:${'2'.repeat(64)}`,
        }),
      }),
      (error: any) => {
        assert.equal(error.details?.failure_code, 'domain_lifecycle_stage_launch_blocked');
        assert.equal(error.details?.observation_reason, 'workspace_cas_read_generation_changed');
        return true;
      },
    );

    const catalogFile = path.join(checkoutRoot, 'contracts', 'action_catalog.json');
    const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    catalog.actions.splice(1, 0, {
      ...catalog.actions[0],
      action_id: 'launch_stage_alias',
      title: 'Launch stage alias',
    });
    fs.writeFileSync(catalogFile, JSON.stringify(catalog));
    assert.throws(
      () => preflightFamilyRuntimeDomainLifecycleAdmission({ ...launch, actionId: null }),
      /action identity is ambiguous/i,
    );
  } finally {
    if (previousStateRoot === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateRoot;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('direct family-runtime create --start gates before attempt reserve and replays after active recovery', async () => {
  const fixtureRoot = temporaryRoot('opl-family-lifecycle-direct-');
  const checkoutRoot = path.join(fixtureRoot, 'checkout');
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  const stateRoot = path.join(fixtureRoot, 'state');
  const previousStateRoot = process.env.OPL_STATE_DIR;
  const host = await createCordisBaseHeadlessComposition();
  try {
    fs.mkdirSync(checkoutRoot, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    process.env.OPL_STATE_DIR = stateRoot;
    writeLifecycleContracts(checkoutRoot);
    const refs = writeLifecycleWorkspace(workspaceRoot);
    const args = [
      'attempt', 'create', '--domain', 'mas', '--stage', 'intake', '--action', 'launch_stage',
      '--provider', 'temporal', '--workspace-locator', JSON.stringify({
        workspace_root: workspaceRoot,
        study_id: 'study-001',
      }),
      '--source-fingerprint', 'sha256:direct-lifecycle-fixture',
      '--blocked-reason', 'fixture_provider_start_disabled',
      '--start',
    ];
    const runtime = {
      ensurePackageLaunchReady: async () => ({
        runtime_source_readiness: { checkout_path: checkoutRoot },
        ...nativeCarrierReadiness(checkoutRoot),
        package_use_binding: packageUseBinding(),
      }) as never,
      resolveStageBinding: () => null,
    };

    await assert.rejects(
      runFamilyRuntime(args, {
        stageRunRuntime: runtime,
        createStageRouteComposition: host.services.childFactories.createStageRouteComposition,
      }),
      /lifecycle is inactive/i,
    );
    const beforeRecovery = await runFamilyRuntime(['attempt', 'list']);
    assert.equal((beforeRecovery.family_runtime_stage_attempts as any).attempts.length, 0);

    writeJson(fileURLToPath(refs.lifecycle.ref), {
      study_id: 'study-001', lifecycle_state: 'active', lifecycle_generation: 8,
    });
    writeLifecycleCasReadState({
      stateRoot,
      workspaceRoot,
      phase: 'in_progress',
      transitionId: 'direct-pending',
      journal: true,
    });
    await assert.rejects(
      runFamilyRuntime(args, {
        stageRunRuntime: runtime,
        createStageRouteComposition: host.services.childFactories.createStageRouteComposition,
      }),
      /sync-pending/i,
    );
    const whileCasPending = await runFamilyRuntime(['attempt', 'list']);
    assert.equal((whileCasPending.family_runtime_stage_attempts as any).attempts.length, 0);
    writeLifecycleCasReadState({
      stateRoot,
      workspaceRoot,
      phase: 'settled',
      transitionId: 'direct-settled',
      journal: false,
    });
    const launched = await runFamilyRuntime(args, {
      stageRunRuntime: runtime,
      createStageRouteComposition: host.services.childFactories.createStageRouteComposition,
    });
    const replayed = await runFamilyRuntime(args, {
      stageRunRuntime: runtime,
      createStageRouteComposition: host.services.childFactories.createStageRouteComposition,
    });
    const launchedAttempt = (launched.family_runtime_stage_attempt as any).attempt;
    const replayedSurface = replayed.family_runtime_stage_attempt as any;
    assert.equal(launchedAttempt.status, 'blocked');
    assert.equal(launchedAttempt.provider_run.execution_package_use_context ?? null, null);
    assert.equal((launched.family_runtime_stage_attempt as any).temporal_start, null);
    assert.equal(replayedSurface.idempotent_noop, true);
    assert.equal(replayedSurface.attempt.stage_attempt_id, launchedAttempt.stage_attempt_id);
    const launchEvent = launchedAttempt.activity_events.find((event: any) => (
      event.event_kind === 'stage_context_observed'
    ));
    assert.equal(
      launchEvent?.observation.domain_lifecycle_admission.status,
      'admitted_by_canonical_active_lifecycle',
    );
  } finally {
    await host.dispose();
    if (previousStateRoot === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateRoot;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('legacy observation-only plan without action or pack stays typed not-declared', async () => {
  const fixtureRoot = temporaryRoot('opl-family-lifecycle-legacy-observation-');
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  const stateRoot = path.join(fixtureRoot, 'state');
  const previousStateRoot = process.env.OPL_STATE_DIR;
  const host = await createCordisBaseHeadlessComposition();
  try {
    fs.mkdirSync(workspaceRoot, { recursive: true });
    process.env.OPL_STATE_DIR = stateRoot;
    const planned = await runFamilyRuntime([
      'attempt', 'create', '--domain', 'mas', '--stage', 'write',
      '--provider', 'temporal', '--workspace-locator', JSON.stringify({
        workspace_root: workspaceRoot,
        study_id: 'legacy-study-observation',
      }),
      '--source-fingerprint', `sha256:${'6'.repeat(64)}`,
    ], {
      createStageRouteComposition: host.services.childFactories.createStageRouteComposition,
      stageRunRuntime: {
        ensurePackageLaunchReady: async () => null,
        resolveStageBinding: () => null,
        startWorkflow: async () => assert.fail('observation-only plan must not start a provider'),
      },
    });
    assert.equal(
      (planned.family_runtime_stage_attempt as any)
        .stage_context_observation.domain_lifecycle_admission.status,
      'not_declared',
    );
    assert.equal((planned.family_runtime_stage_attempt as any).temporal_start, null);
  } finally {
    await host.dispose();
    if (previousStateRoot === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateRoot;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
