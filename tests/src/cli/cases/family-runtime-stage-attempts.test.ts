import { pathToFileURL } from 'node:url';

import { assert, createRuntimeWorkspaceFixture, fs, installRuntimePackageFixture, os, path, runCli, runCliFailure, test } from '../helpers.ts';

function familyRuntimeEnv(stateRoot: string, envOverrides: Record<string, string> = {}) {
  return { OPL_STATE_DIR: stateRoot, ...envOverrides };
}

function createFixtureAttempt(stateRoot: string, sourceFingerprint: string) {
  const omaModulePath = installRuntimePackageFixture(stateRoot, 'opl-meta-agent');
  const workspaceRoot = createRuntimeWorkspaceFixture(stateRoot, 'oma-runtime');
  return runCli([
    'family-runtime',
    'attempt',
    'create',
    '--domain',
    'opl-meta-agent',
    '--stage',
    'reference_build',
    '--provider',
    'temporal',
    '--workspace-locator',
    JSON.stringify({ workspace_root: workspaceRoot }),
    '--source-fingerprint',
    sourceFingerprint,
  ], familyRuntimeEnv(stateRoot, {
    OPL_MODULE_PATH_OPLMETAAGENT: omaModulePath,
  })).family_runtime_stage_attempt.attempt.stage_attempt_id as string;
}

test('family-runtime attempt query exposes a blocked public envelope', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-attempt-blocked-envelope-'));
  try {
    const redcubeModulePath = installRuntimePackageFixture(stateRoot, 'redcube-ai');
    const workspaceRoot = createRuntimeWorkspaceFixture(stateRoot, 'redcube-runtime');
    const created = runCli([
      'family-runtime',
      'attempt',
      'create',
      '--domain',
      'redcube',
      '--stage',
      'closeout',
      '--provider',
      'temporal',
      '--workspace-locator',
      JSON.stringify({ workspace_root: workspaceRoot }),
      '--source-fingerprint',
      'sha256:b8e4e68a9953e8b023ed95131d2915689a309c910b380823ef04d8e05d05de72',
      '--blocked-reason',
      'zero_readable_artifact',
    ], familyRuntimeEnv(stateRoot, {
      OPL_MODULE_PATH_REDCUBE: redcubeModulePath,
    }));
    const attemptId = created.family_runtime_stage_attempt.attempt.stage_attempt_id;
    const query = runCli([
      'family-runtime',
      'attempt',
      'query',
      attemptId,
    ], familyRuntimeEnv(stateRoot)).family_runtime_stage_attempt_query.stage_attempt_query;

    assert.equal(query.canonical_outcome, 'blocked');
    assert.ok(
      query.conflict_or_blocker_envelopes.some(
        (envelope: { classification: string; reason: string }) =>
          envelope.classification === 'evidence_blocker'
          && envelope.reason === 'zero_readable_artifact',
      ),
    );
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});
test('family-runtime attempt readback preserves provider lifecycle without domain authority', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-attempt-no-authority-'));
  try {
    const redcubeModulePath = installRuntimePackageFixture(stateRoot, 'redcube-ai');
    const workspaceRoot = createRuntimeWorkspaceFixture(stateRoot, 'redcube-runtime');
    const created = runCli([
      'family-runtime',
      'attempt',
      'create',
      '--domain',
      'redcube',
      '--stage',
      'artifact_creation',
      '--provider',
      'temporal',
      '--workspace-locator',
      JSON.stringify({ workspace_root: workspaceRoot }),
      '--source-fingerprint',
      'sha256:f44e85c4b8ea2addc796f8beab6600e801d767ccd26c800dce6d88fdaa5eb4e6',
    ], familyRuntimeEnv(stateRoot, {
      OPL_MODULE_PATH_REDCUBE: redcubeModulePath,
    }));
    const query = runCli([
      'family-runtime',
      'attempt',
      'query',
      created.family_runtime_stage_attempt.attempt.stage_attempt_id,
    ], familyRuntimeEnv(stateRoot)).family_runtime_stage_attempt_query;

    assert.equal(query.stage_attempt_query.workflow_contract.provider_kind, 'temporal');
    assert.equal(query.temporal_query.status, 'unavailable');
    assert.equal(
      query.stage_attempt_query.completion_boundary.provider_completion_is_domain_ready,
      false,
    );
    assert.equal(created.family_runtime_stage_attempt.launch_invocation.authority_boundary.can_execute_stage, false);
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('family-runtime attempt roundtrip preserves a consumable domain-owned output ref without reading its body', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-attempt-domain-output-'));
  try {
    const stageAttemptId = createFixtureAttempt(
      stateRoot,
      'sha256:ee0b4158d6f307372ef436fc1f93ed877ee3e2d3771bd46e8068b6d566deb1c3',
    );
    const domainOutputPath = path.join(stateRoot, 'oma-reference-build-output.json');
    const domainOutputPayload = {
      stage_decomposition_pack_draft: {
        stage_ids: ['source_analysis', 'reference_build'],
      },
      materialized_files: ['agent/stages/manifest.json', 'contracts/capability_map.json'],
      owner_verdict: 'domain_ready',
      domain_ready: true,
      next_owner: 'forged-owner',
      authority_boundary: { opl: 'domain_truth_owner' },
    };
    fs.writeFileSync(domainOutputPath, `${JSON.stringify(domainOutputPayload)}\n`, 'utf8');
    const outputRef = pathToFileURL(domainOutputPath).href;
    const domainOutput = {
      surface_kind: 'domain_owned_stage_output_ref',
      version: 'domain-owned-stage-output-ref.v1',
      domain_id: 'agent_engineering',
      output_ref: outputRef,
    };

    runCli([
      'family-runtime',
      'attempt',
      'fixture-run',
      stageAttemptId,
      '--closeout-packet',
      JSON.stringify({
        surface_kind: 'stage_attempt_closeout_packet',
        closeout_refs: ['receipt:oma-reference-build', outputRef],
        domain_output: domainOutput,
      }),
    ], familyRuntimeEnv(stateRoot));
    const query = runCli([
      'family-runtime',
      'attempt',
      'query',
      stageAttemptId,
    ], familyRuntimeEnv(stateRoot)).family_runtime_stage_attempt_query.stage_attempt_query;

    assert.deepEqual(query.domain_output, domainOutput);
    assert.equal(query.operator_visibility.domain_output_ref, outputRef);
    assert.equal(query.operator_visibility.domain_output, undefined);
    assert.equal(query.completion_boundary.domain_ready_verdict, null);
    assert.equal(query.completion_boundary.provider_completion_is_domain_ready, false);
    assert.equal(query.operator_visibility.next_owner, 'agent_engineering');
    assert.equal(
      query.operator_visibility.authority_boundary.opl,
      'attempt_control_metadata_projection_only',
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(new URL(query.domain_output.output_ref), 'utf8')),
      domainOutputPayload,
    );
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('family-runtime attempt rejects domain output refs that cross the attempt boundary', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-attempt-domain-output-guard-'));
  try {
    for (const testCase of [
      {
        name: 'domain mismatch',
        sourceFingerprint: 'sha256:68cc03bdff093b7424d71dff1a09a728497c9fa1c641380348593465ddc15349',
        domainOutput: {
          surface_kind: 'domain_owned_stage_output_ref',
          version: 'domain-owned-stage-output-ref.v1',
          domain_id: 'medautoscience',
          output_ref: 'file:///tmp/oma-domain-output.json',
        },
        closeoutRefs: ['receipt:oma-domain-output', 'file:///tmp/oma-domain-output.json'],
        expected: /domain_output\.domain_id must match the stage attempt domain/,
      },
      {
        name: 'unbound output ref',
        sourceFingerprint: 'sha256:d5944b35b3ea2352d16c860e1a0db4058470b2f4954f5583558ee39d3c2a5c31',
        domainOutput: {
          surface_kind: 'domain_owned_stage_output_ref',
          version: 'domain-owned-stage-output-ref.v1',
          domain_id: 'agent_engineering',
          output_ref: 'file:///tmp/oma-domain-output.json',
        },
        closeoutRefs: ['receipt:oma-domain-output'],
        expected: /domain_output\.output_ref must be present in closeout_refs/,
      },
    ]) {
      const stageAttemptId = createFixtureAttempt(stateRoot, testCase.sourceFingerprint);
      const failure = runCliFailure([
        'family-runtime',
        'attempt',
        'fixture-run',
        stageAttemptId,
        '--closeout-packet',
        JSON.stringify({
          surface_kind: 'stage_attempt_closeout_packet',
          closeout_refs: testCase.closeoutRefs,
          domain_output: testCase.domainOutput,
        }),
      ], familyRuntimeEnv(stateRoot));

      assert.equal(failure.payload.error.code, 'contract_shape_invalid', testCase.name);
      assert.match(failure.payload.error.message, testCase.expected, testCase.name);
      const query = runCli([
        'family-runtime',
        'attempt',
        'query',
        stageAttemptId,
      ], familyRuntimeEnv(stateRoot)).family_runtime_stage_attempt_query.stage_attempt_query;
      assert.deepEqual(query.closeouts, [], testCase.name);
    }
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('family-runtime attempt strips inline domain output fields before ledger writes', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-attempt-domain-output-strip-'));
  try {
    const stageAttemptId = createFixtureAttempt(
      stateRoot,
      'sha256:416d6f08856f5ff5d5933901510c8355f25457016d457956ca9a5313d81569a2',
    );
    const outputRef = 'file:///tmp/oma-domain-output.json';
    runCli([
      'family-runtime',
      'attempt',
      'fixture-run',
      stageAttemptId,
      '--closeout-packet',
      JSON.stringify({
        surface_kind: 'stage_attempt_closeout_packet',
        closeout_refs: ['receipt:oma-domain-output', outputRef],
        domain_output: {
          surface_kind: 'domain_owned_stage_output_ref',
          version: 'domain-owned-stage-output-ref.v1',
          domain_id: 'agent_engineering',
          output_ref: outputRef,
          payload: { stage_decomposition_pack_draft: { forbidden: true } },
        },
      }),
    ], familyRuntimeEnv(stateRoot)) as any;
    const query = runCli([
      'family-runtime',
      'attempt',
      'query',
      stageAttemptId,
    ], familyRuntimeEnv(stateRoot)).family_runtime_stage_attempt_query.stage_attempt_query;

    assert.deepEqual(query.domain_output, {
      surface_kind: 'domain_owned_stage_output_ref',
      version: 'domain-owned-stage-output-ref.v1',
      domain_id: 'agent_engineering',
      output_ref: outputRef,
    });
    assert.equal(query.closeouts.length, 1);
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});
