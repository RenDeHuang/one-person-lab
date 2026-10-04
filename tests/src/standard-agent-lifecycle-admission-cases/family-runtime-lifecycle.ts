import {
  assert,
  fs,
  path,
  test,
  fileURLToPath,
  DatabaseSync,
  FrameworkContractError,
  buildPackBoundTemporalStageRunInput,
  buildRouteStageRunInvocation,
  stageAttemptExecutionContentBindingSha256,
  stageRunSpecSha256,
  digest,
  createCordisBaseHeadlessComposition,
  createFamilyRuntimeQueueTables,
  createStageRunLaunchTable,
  ensureProviderHostedStageAttempt,
  launchRegisteredStageRun,
  materializeStageRunRoute,
  normalizeStageQualityCyclePolicy,
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
} from './shared.ts';
import type {
  FamilyRuntimeTaskRow,
  StandardAgentStageQualityRuntimeBinding,
} from './shared.ts';

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

test('public plan-only StageRun launch requires active lifecycle before durable registration', async () => {
  const fixtureRoot = temporaryRoot('opl-family-lifecycle-plan-only-');
  const checkoutRoot = path.join(fixtureRoot, 'checkout');
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  const stateRoot = path.join(fixtureRoot, 'state');
  const previousStateRoot = process.env.OPL_STATE_DIR;
  try {
    fs.mkdirSync(checkoutRoot, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    process.env.OPL_STATE_DIR = stateRoot;
    writeLifecycleContracts(checkoutRoot);
    const refs = writeLifecycleWorkspace(workspaceRoot);
    const files: Record<string, string> = {
      'contracts/stage-quality.json': '{}',
      'agent/prompts/intake.md': '# Intake\n',
      'agent/prompts/quality.md': [
        '# Quality',
        '## Producer', 'Produce.',
        '## Reviewer', 'Review.',
        '## Repairer', 'Repair.',
        '## Re-reviewer', 'Re-review.',
      ].join('\n'),
      'agent/quality_gates/stage.md': '# Rubric\n',
      'agent/goals/intake.md': '# Intake goal\n',
      'agent/sources/request.md': '# Request\n',
      'agent/lineage/intake.json': '{"stage_id":"intake"}\n',
    };
    for (const [relativePath, bytes] of Object.entries(files)) {
      const file = path.join(checkoutRoot, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
    const binding: StandardAgentStageQualityRuntimeBinding = {
      surface_kind: 'opl_pack_bound_stage_quality_runtime_binding',
      version: 'opl-pack-bound-stage-quality-runtime-binding.v1',
      stage_id: 'intake',
      declared_stage_ids: ['intake'],
      enabled: true,
      stage_role: null,
      policy_ref: 'contracts/stage-quality.json',
      stage_prompt_ref: 'agent/prompts/intake.md',
      quality_policy: normalizeStageQualityCyclePolicy({
        formal_review: { required: true, risk_tier: 'high', max_repair_rounds: 1 },
      }),
      handoff_review_boundary: null,
      role_prompt_refs: {
        producer: 'agent/prompts/quality.md#producer',
        reviewer: 'agent/prompts/quality.md#reviewer',
        repairer: 'agent/prompts/quality.md#repairer',
        re_reviewer: 'agent/prompts/quality.md#re-reviewer',
      },
      quality_rubric_refs: ['agent/quality_gates/stage.md'],
      stage_goal_refs: ['agent/goals/intake.md'],
      source_refs: ['agent/sources/request.md'],
      lineage_refs: ['agent/lineage/intake.json'],
      manifest_ref: 'agent/stages/manifest.json',
      manifest_sha256: digest(fs.readFileSync(path.join(checkoutRoot, 'agent/stages/manifest.json'))),
    };
    const stageRunInput = buildPackBoundTemporalStageRunInput({
      binding,
      domainPackRoot: checkoutRoot,
      domainId: 'mas',
      stageId: 'intake',
      stageRunInvocationId: 'sri_lifecycle_plan_only',
      workspaceLocator: {
        workspace_root: workspaceRoot,
        study_id: 'study-001',
        package_use_binding: packageUseBinding(),
      },
      sourceFingerprint: `sha256:${'7'.repeat(64)}`,
      executorKind: 'codex_cli',
      actionId: 'launch_stage',
    });
    const db = new DatabaseSync(':memory:');
    createStageRunLaunchTable(db);

    try {
      await assert.rejects(
        launchRegisteredStageRun({
          db,
          stageRunInput,
          start: false,
          startWorkflow: async () => assert.fail('plan-only launch must not start Temporal'),
        }),
        /lifecycle is inactive/i,
      );
      assert.equal((db.prepare(
        'SELECT COUNT(*) AS count FROM stage_run_launches',
      ).get() as any).count, 0);

      writeJson(fileURLToPath(refs.lifecycle.ref), {
        study_id: 'study-001', lifecycle_state: 'active', lifecycle_generation: 8,
      });
      writeLifecycleCasReadState({
        stateRoot,
        workspaceRoot,
        phase: 'settled',
        transitionId: 'plan-only-open-journal',
        journal: true,
      });
      await assert.rejects(
        launchRegisteredStageRun({
          db,
          stageRunInput,
          start: false,
          startWorkflow: async () => assert.fail('plan-only launch must not start Temporal'),
        }),
        (error: any) => {
          assert.equal(error.details?.failure_code, 'domain_lifecycle_stage_launch_blocked');
          assert.equal(error.details?.observation_reason, 'workspace_cas_journal_present');
          return true;
        },
      );
      assert.equal((db.prepare(
        'SELECT COUNT(*) AS count FROM stage_run_launches',
      ).get() as any).count, 0);
      writeLifecycleCasReadState({
        stateRoot,
        workspaceRoot,
        phase: 'settled',
        transitionId: 'plan-only-settled',
        journal: false,
      });
      const planned = await launchRegisteredStageRun({
        db,
        stageRunInput,
        start: false,
        startWorkflow: async () => assert.fail('plan-only launch must not start Temporal'),
      });
      assert.equal(planned.start_status, 'registered');
      assert.equal((db.prepare(
        'SELECT COUNT(*) AS count FROM stage_run_launches',
      ).get() as any).count, 1);
    } finally {
      db.close();
    }
  } finally {
    if (previousStateRoot === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateRoot;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('provider-hosted launch preserves currentness observation and gates before attempt creation', async () => {
  const fixtureRoot = temporaryRoot('opl-family-lifecycle-provider-hosted-');
  const checkoutRoot = path.join(fixtureRoot, 'checkout');
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  const stateRoot = path.join(fixtureRoot, 'state');
  const previousStateRoot = process.env.OPL_STATE_DIR;
  const host = await createCordisBaseHeadlessComposition();
  const db = new DatabaseSync(':memory:');
  createFamilyRuntimeQueueTables(db);
  try {
    fs.mkdirSync(checkoutRoot, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    process.env.OPL_STATE_DIR = stateRoot;
    writeLifecycleContracts(checkoutRoot);
    const refs = writeLifecycleWorkspace(workspaceRoot);
    const now = new Date().toISOString();
    const row: FamilyRuntimeTaskRow = {
      task_id: 'task:lifecycle-provider-hosted',
      domain_id: 'medautoscience',
      task_kind: 'test/lifecycle-provider-hosted',
      payload_json: '{}',
      dedupe_key: null,
      priority: 0,
      status: 'queued',
      attempts: 0,
      max_attempts: 3,
      source: 'test',
      requires_approval: 0,
      approved_at: null,
      lease_owner: null,
      lease_expires_at: null,
      last_error: null,
      dead_letter_reason: null,
      created_at: now,
      updated_at: now,
    };
    const payload = {
      opl_provider_hosted_stage_attempt: true,
      stage_id: 'intake',
      study_id: 'study-001',
      workspace_root: workspaceRoot,
    };
    const options = {
      createStageRouteComposition: host.services.childFactories.createStageRouteComposition,
      ensurePackageLaunchReady: async () => ({
        runtime_source_readiness: { checkout_path: checkoutRoot },
        ...nativeCarrierReadiness(checkoutRoot),
        package_use_binding: packageUseBinding(),
      }) as never,
    };

    await assert.rejects(
      ensureProviderHostedStageAttempt(db, row, payload, options),
      /lifecycle is inactive/i,
    );
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM stage_attempts').get() as any).count, 0);

    writeJson(fileURLToPath(refs.lifecycle.ref), {
      study_id: 'study-001', lifecycle_state: 'active', lifecycle_generation: 8,
    });
    writeLifecycleCasReadState({
      stateRoot,
      workspaceRoot,
      phase: 'in_progress',
      transitionId: 'provider-pending',
      journal: true,
    });
    await assert.rejects(
      ensureProviderHostedStageAttempt(db, row, payload, options),
      /sync-pending/i,
    );
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM stage_attempts').get() as any).count, 0);
    writeLifecycleCasReadState({
      stateRoot,
      workspaceRoot,
      phase: 'settled',
      transitionId: 'provider-settled',
      journal: false,
    });
    const attempt = await ensureProviderHostedStageAttempt(db, row, payload, options);
    assert.ok(attempt);
    const launchEvent = attempt.activity_events.find((event: any) => (
      event.event_kind === 'stage_context_observed'
    ));
    assert.equal(
      launchEvent?.observation.domain_lifecycle_admission.status,
      'admitted_by_canonical_active_lifecycle',
    );
    assert.equal(launchEvent?.observation.status, 'declaration_debt');
  } finally {
    await host.dispose();
    if (previousStateRoot === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateRoot;
    db.close();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('route launch requires fresh active lifecycle on first launch and persisted replay', async () => {
  const fixtureRoot = temporaryRoot('opl-family-lifecycle-route-');
  const checkoutRoot = path.join(fixtureRoot, 'checkout');
  const readinessCheckoutRoot = path.join(fixtureRoot, 'readiness-checkout');
  const raceCheckoutRoot = path.join(fixtureRoot, 'race-checkout');
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  const stateRoot = path.join(fixtureRoot, 'state');
  const previousStateRoot = process.env.OPL_STATE_DIR;
  try {
    fs.mkdirSync(checkoutRoot, { recursive: true });
    fs.mkdirSync(readinessCheckoutRoot, { recursive: true });
    fs.mkdirSync(raceCheckoutRoot, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    process.env.OPL_STATE_DIR = stateRoot;
    writeLifecycleContracts(checkoutRoot);
    writeLifecycleContracts(readinessCheckoutRoot);
    writeLifecycleContracts(raceCheckoutRoot);
    const refs = writeLifecycleWorkspace(workspaceRoot);
    const files: Record<string, string> = {
      'contracts/stage-quality.json': '{}',
      'agent/prompts/intake.md': '# Intake\n',
      'agent/prompts/draft.md': '# Draft\n',
      'agent/prompts/quality.md': [
        '# Quality',
        '## Producer', 'Produce.',
        '## Reviewer', 'Review.',
        '## Repairer', 'Repair.',
        '## Re-reviewer', 'Re-review.',
      ].join('\n'),
      'agent/quality_gates/stage.md': '# Rubric\n',
      'agent/goals/intake.md': '# Intake goal\n',
      'agent/goals/draft.md': '# Draft goal\n',
      'agent/sources/request.md': '# Request\n',
      'agent/lineage/intake.json': '{"stage_id":"intake"}\n',
      'agent/lineage/draft.json': '{"stage_id":"draft"}\n',
      'artifacts/request.json': '{"request":"revise"}\n',
    };
    for (const [relativePath, bytes] of Object.entries(files)) {
      const root = relativePath.startsWith('artifacts/') ? workspaceRoot : checkoutRoot;
      const file = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
    fs.cpSync(checkoutRoot, readinessCheckoutRoot, { recursive: true });
    fs.cpSync(checkoutRoot, raceCheckoutRoot, { recursive: true });
    const manifestSha256 = digest(fs.readFileSync(path.join(checkoutRoot, 'agent/stages/manifest.json')));
    const binding = (
      stageId: string,
      reviewLaneBinding?: StandardAgentStageQualityRuntimeBinding['review_lane_binding'],
    ): StandardAgentStageQualityRuntimeBinding => ({
      surface_kind: 'opl_pack_bound_stage_quality_runtime_binding',
      version: 'opl-pack-bound-stage-quality-runtime-binding.v1',
      stage_id: stageId,
      declared_stage_ids: ['draft', 'intake'],
      enabled: true,
      stage_role: null,
      policy_ref: 'contracts/stage-quality.json',
      stage_prompt_ref: `agent/prompts/${stageId}.md`,
      quality_policy: normalizeStageQualityCyclePolicy({
        formal_review: { required: true, risk_tier: 'high', max_repair_rounds: 1 },
      }),
      handoff_review_boundary: null,
      role_prompt_refs: {
        producer: 'agent/prompts/quality.md#producer',
        reviewer: 'agent/prompts/quality.md#reviewer',
        repairer: 'agent/prompts/quality.md#repairer',
        re_reviewer: 'agent/prompts/quality.md#re-reviewer',
      },
      quality_rubric_refs: ['agent/quality_gates/stage.md'],
      stage_goal_refs: [`agent/goals/${stageId}.md`],
      source_refs: ['agent/sources/request.md'],
      lineage_refs: [`agent/lineage/${stageId}.json`],
      ...(reviewLaneBinding === undefined ? {} : { review_lane_binding: reviewLaneBinding }),
      manifest_ref: 'agent/stages/manifest.json',
      manifest_sha256: manifestSha256,
    });
    const artifactBytes = fs.readFileSync(path.join(workspaceRoot, 'artifacts/request.json'));
    const artifactSha256 = `sha256:${digest(artifactBytes)}`;
    const parent = buildPackBoundTemporalStageRunInput({
      binding: binding('intake'),
      domainPackRoot: checkoutRoot,
      domainId: 'mas',
      stageId: 'intake',
      stageRunInvocationId: 'sri_lifecycle_route_parent',
      workspaceLocator: {
        workspace_root: workspaceRoot,
        study_id: 'study-001',
        domain_pack_root: checkoutRoot,
        package_use_binding: packageUseBinding(),
      },
      sourceFingerprint: artifactSha256,
      executorKind: 'codex_cli',
      actionId: 'launch_stage',
      artifactRefs: ['artifacts/request.json'],
      artifactHashes: [artifactSha256],
    });
    const decisivePayload = {
      parent_stage_run_spec_sha256: parent.stage_run_spec_sha256,
      use_boundary_id: 'package-use:lifecycle-route-decisive',
      spec_sha256: stageRunSpecSha256(parent.stage_run_spec),
      spec: parent.stage_run_spec,
      declared_stage_ids: parent.declared_stage_ids,
    };
    const routeInput = {
      parent_stage_run: parent,
      decisive_attempt_ref: 'opl://stage_attempts/lifecycle-route-reviewer',
      decisive_execution_content_binding: {
        surface_kind: 'opl_stage_attempt_execution_content_binding' as const,
        version: 'opl-stage-attempt-execution-content-binding.v1' as const,
        ...decisivePayload,
        binding_sha256: stageAttemptExecutionContentBindingSha256(decisivePayload),
      },
      decision: {
        decision_kind: 'advance' as const,
        target_stage_id: 'draft',
        evidence_refs: ['artifact:request'],
      },
      artifact_refs: ['artifacts/request.json'],
      artifact_hashes: [artifactSha256],
      artifact_identity_receipt_refs: [],
    };
    let persistedTarget: ReturnType<typeof buildPackBoundTemporalStageRunInput> | null = null;
    let providerStarts = 0;
    const dependencies = {
      findTargetStageRun: () => persistedTarget,
      ensurePackageLaunchReady: async () => ({
        runtime_source_readiness: { checkout_path: checkoutRoot },
        ...nativeCarrierReadiness(checkoutRoot),
        package_use_binding: packageUseBinding(),
      }) as never,
      resolveStageBinding: (_root: string, stageId: string) => binding(stageId),
      launchTargetStageRun: async (target: ReturnType<typeof buildPackBoundTemporalStageRunInput>) => {
        providerStarts += 1;
        const existing = persistedTarget !== null;
        persistedTarget ??= target;
        return { start_status: existing ? 'existing' : 'started' };
      },
    };

    await assert.rejects(
      materializeStageRunRoute(routeInput, dependencies),
      /lifecycle is inactive/i,
    );
    assert.equal(providerStarts, 0);
    assert.equal(persistedTarget, null);

    writeJson(fileURLToPath(refs.lifecycle.ref), {
      study_id: 'study-001', lifecycle_state: 'active', lifecycle_generation: 8,
    });
    writeLifecycleCasReadState({
      stateRoot,
      workspaceRoot,
      phase: 'in_progress',
      transitionId: 'route-pending',
      journal: true,
    });
    await assert.rejects(
      materializeStageRunRoute(routeInput, dependencies),
      /sync-pending/i,
    );
    assert.equal(providerStarts, 0);
    assert.equal(persistedTarget, null);
    writeLifecycleCasReadState({
      stateRoot,
      workspaceRoot,
      phase: 'settled',
      transitionId: 'route-settled',
      journal: false,
    });
    const launched = await materializeStageRunRoute(routeInput, dependencies);
    assert.equal(launched.materialization_status, 'launched');
    assert.equal(providerStarts, 1);

    const fixedLane = (reviewLane: string) => ({
      binding_kind: 'fixed' as const,
      review_lane: reviewLane,
      executor_may_select_lane: false as const,
      lane_fallback: false as const,
    });
    const controllerLane = (allowedReviewLanes: string[]) => ({
      binding_kind: 'controller_required' as const,
      allowed_review_lanes: allowedReviewLanes,
      executor_may_select_lane: false as const,
      lane_fallback: false as const,
    });
    const laneRoute = (
      parentReviewLane: string,
      targetReviewLaneBinding: StandardAgentStageQualityRuntimeBinding['review_lane_binding'],
      invocationSuffix: string,
    ) => {
      const laneParent = buildPackBoundTemporalStageRunInput({
        binding: binding('intake', fixedLane(parentReviewLane)),
        domainPackRoot: checkoutRoot,
        domainId: 'mas',
        stageId: 'intake',
        stageRunInvocationId: `sri_lifecycle_route_lane_parent_${invocationSuffix}`,
        workspaceLocator: {
          workspace_root: workspaceRoot,
          study_id: 'study-001',
          domain_pack_root: checkoutRoot,
          package_use_binding: packageUseBinding(),
        },
        sourceFingerprint: artifactSha256,
        executorKind: 'codex_cli',
        stageAttemptExecutorPolicy: { review_lane_binding: parentReviewLane },
        actionId: 'launch_stage',
        artifactRefs: ['artifacts/request.json'],
        artifactHashes: [artifactSha256],
      });
      const laneDecisivePayload = {
        parent_stage_run_spec_sha256: laneParent.stage_run_spec_sha256,
        use_boundary_id: `package-use:lifecycle-route-lane-${invocationSuffix}`,
        spec_sha256: stageRunSpecSha256(laneParent.stage_run_spec),
        spec: laneParent.stage_run_spec,
        declared_stage_ids: laneParent.declared_stage_ids,
      };
      return {
        routeInput: {
          parent_stage_run: laneParent,
          decisive_attempt_ref: `opl://stage_attempts/lifecycle-route-lane-${invocationSuffix}`,
          decisive_execution_content_binding: {
            surface_kind: 'opl_stage_attempt_execution_content_binding' as const,
            version: 'opl-stage-attempt-execution-content-binding.v1' as const,
            ...laneDecisivePayload,
            binding_sha256: stageAttemptExecutionContentBindingSha256(laneDecisivePayload),
          },
          decision: {
            decision_kind: 'advance' as const,
            target_stage_id: 'draft',
            evidence_refs: ['artifact:request'],
          },
          artifact_refs: ['artifacts/request.json'],
          artifact_hashes: [artifactSha256],
          artifact_identity_receipt_refs: [],
        },
        targetReviewLaneBinding,
      };
    };
    const launchLaneRoute = async (
      parentReviewLane: string,
      targetReviewLaneBinding: StandardAgentStageQualityRuntimeBinding['review_lane_binding'],
      invocationSuffix: string,
    ): Promise<{
      laneResult: Awaited<ReturnType<typeof materializeStageRunRoute>>;
      laneTarget: ReturnType<typeof buildPackBoundTemporalStageRunInput> | null;
      laneStarts: number;
    }> => {
      const lane = laneRoute(parentReviewLane, targetReviewLaneBinding, invocationSuffix);
      let laneTarget: ReturnType<typeof buildPackBoundTemporalStageRunInput> | null = null;
      let laneStarts = 0;
      const laneResult = await materializeStageRunRoute(lane.routeInput, {
        findTargetStageRun: () => laneTarget,
        ensurePackageLaunchReady: async () => ({
          runtime_source_readiness: { checkout_path: checkoutRoot },
          ...nativeCarrierReadiness(checkoutRoot),
          package_use_binding: packageUseBinding(),
        }) as never,
        resolveStageBinding: (_root: string, stageId: string) => (
          stageId === 'draft' ? binding(stageId, targetReviewLaneBinding) : binding(stageId)
        ),
        launchTargetStageRun: async (target) => {
          laneStarts += 1;
          const existing = laneTarget !== null;
          laneTarget ??= target;
          return { start_status: existing ? 'existing' : 'started' };
        },
      });
      return { laneResult, laneTarget, laneStarts };
    };

    const fixedOverride = await launchLaneRoute('medical', fixedLane('statistical'), 'fixed-override');
    assert.equal(fixedOverride.laneStarts, 1);
    assert.equal(
      fixedOverride.laneTarget?.stage_run_spec.stage_attempt_executor_policy?.review_lane_binding,
      'statistical',
    );

    const controllerAllowed = await launchLaneRoute('medical', controllerLane(['medical']), 'controller-allowed');
    assert.equal(controllerAllowed.laneStarts, 1);
    assert.equal(
      controllerAllowed.laneTarget?.stage_run_spec.stage_attempt_executor_policy?.review_lane_binding,
      'medical',
    );

    let controllerDisallowedStarts = 0;
    const disallowedLane = laneRoute('statistical', controllerLane(['medical']), 'controller-disallowed');
    await assert.rejects(
      materializeStageRunRoute(disallowedLane.routeInput, {
        ensurePackageLaunchReady: async () => {
          controllerDisallowedStarts += 1;
          return {
            runtime_source_readiness: { checkout_path: checkoutRoot },
            ...nativeCarrierReadiness(checkoutRoot),
            package_use_binding: packageUseBinding(),
          } as never;
        },
        resolveStageBinding: (_root: string, stageId: string) => (
          stageId === 'draft' ? binding(stageId, disallowedLane.targetReviewLaneBinding) : binding(stageId)
        ),
        launchTargetStageRun: async () => {
          controllerDisallowedStarts += 1;
          return { start_status: 'started' };
        },
      }),
      (error: unknown) => (
        error instanceof FrameworkContractError
        && error.details?.failure_code === 'route_target_review_lane_binding_mismatch'
      ),
    );
    assert.equal(controllerDisallowedStarts, 1);

    const undeclaredTarget = await launchLaneRoute('medical', null, 'undeclared-target');
    assert.equal(undeclaredTarget.laneStarts, 1);
    assert.equal(
      Object.hasOwn(undeclaredTarget.laneTarget?.stage_run_spec.stage_attempt_executor_policy ?? {}, 'review_lane_binding'),
      false,
    );

    // A controller-bound target whose parent Stage declares no review lane is ordinary
    // quality debt, not a route conflict: the consolidated review Stage owns no review
    // transport, so route_back into a controller-bound manuscript Stage must still
    // materialize (with the lane omitted) so the repair round can run.
    const laneLessParent = buildPackBoundTemporalStageRunInput({
      binding: binding('intake'),
      domainPackRoot: checkoutRoot,
      domainId: 'mas',
      stageId: 'intake',
      stageRunInvocationId: 'sri_lifecycle_route_lane_parent_no_lane',
      workspaceLocator: {
        workspace_root: workspaceRoot,
        study_id: 'study-001',
        domain_pack_root: checkoutRoot,
        package_use_binding: packageUseBinding(),
      },
      sourceFingerprint: artifactSha256,
      executorKind: 'codex_cli',
      stageAttemptExecutorPolicy: { invocation_mode: 'invocation' },
      actionId: 'launch_stage',
      artifactRefs: ['artifacts/request.json'],
      artifactHashes: [artifactSha256],
    });
    const laneLessDecisivePayload = {
      parent_stage_run_spec_sha256: laneLessParent.stage_run_spec_sha256,
      use_boundary_id: 'package-use:lifecycle-route-lane-no-lane',
      spec_sha256: stageRunSpecSha256(laneLessParent.stage_run_spec),
      spec: laneLessParent.stage_run_spec,
      declared_stage_ids: laneLessParent.declared_stage_ids,
    };
    let laneLessTarget: ReturnType<typeof buildPackBoundTemporalStageRunInput> | null = null;
    let laneLessStarts = 0;
    const laneLessResult = await materializeStageRunRoute({
      parent_stage_run: laneLessParent,
      decisive_attempt_ref: 'opl://stage_attempts/lifecycle-route-lane-no-lane',
      decisive_execution_content_binding: {
        surface_kind: 'opl_stage_attempt_execution_content_binding' as const,
        version: 'opl-stage-attempt-execution-content-binding.v1' as const,
        ...laneLessDecisivePayload,
        binding_sha256: stageAttemptExecutionContentBindingSha256(laneLessDecisivePayload),
      },
      decision: {
        decision_kind: 'route_back' as const,
        target_stage_id: 'draft',
        evidence_refs: ['artifact:request'],
      },
      artifact_refs: ['artifacts/request.json'],
      artifact_hashes: [artifactSha256],
      artifact_identity_receipt_refs: [],
    }, {
      findTargetStageRun: () => laneLessTarget,
      ensurePackageLaunchReady: async () => ({
        runtime_source_readiness: { checkout_path: checkoutRoot },
        ...nativeCarrierReadiness(checkoutRoot),
        package_use_binding: packageUseBinding(),
      }) as never,
      resolveStageBinding: (_root: string, stageId: string) => (
        stageId === 'draft' ? binding(stageId, controllerLane(['medical', 'display'])) : binding(stageId)
      ),
      launchTargetStageRun: async (target) => {
        laneLessStarts += 1;
        const existing = laneLessTarget !== null;
        laneLessTarget ??= target;
        return { start_status: existing ? 'existing' : 'started' };
      },
    });
    assert.equal(laneLessResult.materialization_status, 'launched');
    assert.equal(laneLessStarts, 1);
    const laneLessLaunchTarget = laneLessTarget as unknown as ReturnType<
      typeof buildPackBoundTemporalStageRunInput
    > | null;
    assert.equal(
      Object.hasOwn(
        laneLessLaunchTarget?.stage_run_spec.stage_attempt_executor_policy ?? {},
        'review_lane_binding',
      ),
      false,
    );

    const rootDrift = laneRoute('medical', controllerLane(['medical']), 'root-drift');
    const rootDriftRoots: string[] = [];
    let rootDriftTarget: ReturnType<typeof buildPackBoundTemporalStageRunInput> | null = null;
    let rootDriftReadinessCalls = 0;
    let rootDriftLaunches = 0;
    const rootDriftResolveStageBinding = (root: string, stageId: string) => {
      rootDriftRoots.push(root);
      if (root === readinessCheckoutRoot && stageId === 'draft') {
        return binding(stageId, rootDrift.targetReviewLaneBinding);
      }
      return binding(stageId, fixedLane('stale-parent-lane'));
    };
    const rootDriftFirst = await materializeStageRunRoute(rootDrift.routeInput, {
      findTargetStageRun: () => rootDriftTarget,
      ensurePackageLaunchReady: async () => {
        rootDriftReadinessCalls += 1;
        return {
          runtime_source_readiness: { checkout_path: readinessCheckoutRoot },
          ...nativeCarrierReadiness(readinessCheckoutRoot),
          package_use_binding: packageUseBinding(),
        } as never;
      },
      resolveStageBinding: rootDriftResolveStageBinding,
      launchTargetStageRun: async (target) => {
        rootDriftLaunches += 1;
        rootDriftTarget ??= target;
        return { start_status: rootDriftLaunches === 1 ? 'started' : 'existing' };
      },
    });
    assert.equal(rootDriftFirst.materialization_status, 'launched');
    const rootDriftLaunchTarget = rootDriftTarget as unknown as ReturnType<
      typeof buildPackBoundTemporalStageRunInput
    >;
    assert.equal(rootDriftLaunchTarget.domain_pack_root, readinessCheckoutRoot);
    assert.equal(
      rootDriftLaunchTarget.stage_run_spec.stage_attempt_executor_policy?.review_lane_binding,
      'medical',
    );
    assert.deepEqual(rootDriftRoots, [readinessCheckoutRoot]);

    const rootDriftReplay = await materializeStageRunRoute(rootDrift.routeInput, {
      findTargetStageRun: () => rootDriftTarget,
      ensurePackageLaunchReady: async () => {
        rootDriftReadinessCalls += 1;
        return {
          runtime_source_readiness: { checkout_path: checkoutRoot },
          ...nativeCarrierReadiness(checkoutRoot),
          package_use_binding: packageUseBinding(),
        } as never;
      },
      resolveStageBinding: rootDriftResolveStageBinding,
      launchTargetStageRun: async () => {
        rootDriftLaunches += 1;
        return { start_status: 'existing' };
      },
    });
    assert.equal(rootDriftReplay.materialization_status, 'existing');
    assert.equal(rootDriftReadinessCalls, 1);
    assert.equal(rootDriftRoots.at(-1), readinessCheckoutRoot);
    assert.equal(rootDriftLaunches, 2);

    const raceRootDrift = laneRoute('medical', controllerLane(['medical']), 'race-root-drift');
    const raceParent = raceRootDrift.routeInput.parent_stage_run;
    const raceInvocation = buildRouteStageRunInvocation({
      parentStageRunId: raceParent.stage_run_id,
      decisiveAttemptRef: raceRootDrift.routeInput.decisive_attempt_ref,
      decision: raceRootDrift.routeInput.decision,
      targetStageId: 'draft',
    });
    const raceTarget = buildPackBoundTemporalStageRunInput({
      binding: binding('draft', fixedLane('race-fixed-lane')),
      domainPackRoot: raceCheckoutRoot,
      domainId: raceParent.domain_id,
      stageId: 'draft',
      stageRunInvocationId: raceInvocation.stage_run_invocation_id,
      parentRouteDecisionRef: raceInvocation.parent_route_decision_ref,
      workspaceLocator: {
        ...raceParent.workspace_locator,
        domain_pack_root: raceCheckoutRoot,
        package_use_binding: packageUseBinding(),
      },
      sourceFingerprint: raceParent.source_fingerprint,
      executorKind: raceParent.executor_kind,
      stageAttemptExecutorPolicy: { review_lane_binding: 'race-fixed-lane' },
      artifactRefs: raceRootDrift.routeInput.artifact_refs,
      artifactHashes: raceRootDrift.routeInput.artifact_hashes,
      artifactIdentityReceiptRefs: raceRootDrift.routeInput.artifact_identity_receipt_refs,
      actionId: raceParent.action_id,
      taskId: raceParent.task_id,
      scopeKind: raceParent.scope_kind,
      executionScope: raceParent.execution_scope,
    });
    const raceRoots: string[] = [];
    let raceCandidateAvailable = false;
    let raceLaunches = 0;
    const raceResult = await materializeStageRunRoute(raceRootDrift.routeInput, {
      findTargetStageRun: () => raceCandidateAvailable ? raceTarget : null,
      ensurePackageLaunchReady: async () => ({
        runtime_source_readiness: { checkout_path: readinessCheckoutRoot },
        ...nativeCarrierReadiness(readinessCheckoutRoot),
        package_use_binding: packageUseBinding(),
      }) as never,
      resolveStageBinding: (root: string, stageId: string) => {
        raceRoots.push(root);
        if (root === readinessCheckoutRoot && stageId === 'draft') {
          return binding(stageId, controllerLane(['medical']));
        }
        if (root === raceCheckoutRoot && stageId === 'draft') {
          return binding(stageId, fixedLane('race-fixed-lane'));
        }
        return binding(stageId, fixedLane('stale-parent-lane'));
      },
      launchTargetStageRun: async (target) => {
        raceLaunches += 1;
        if (raceLaunches === 1) {
          raceCandidateAvailable = true;
          throw new FrameworkContractError(
            'contract_shape_invalid',
            'test race conflict',
            { failure_code: 'stage_run_invocation_spec_conflict' },
          );
        }
        assert.equal(target.domain_pack_root, raceCheckoutRoot);
        return { start_status: 'existing' };
      },
    });
    assert.equal(raceResult.materialization_status, 'existing');
    assert.equal(raceLaunches, 2);
    assert.deepEqual(raceRoots, [readinessCheckoutRoot, raceCheckoutRoot]);

    writeJson(fileURLToPath(refs.lifecycle.ref), {
      study_id: 'study-001', lifecycle_state: 'paused', lifecycle_generation: 9,
    });
    await assert.rejects(
      materializeStageRunRoute(routeInput, dependencies),
      /lifecycle is inactive/i,
    );
    assert.equal(providerStarts, 1);
  } finally {
    if (previousStateRoot === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateRoot;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
