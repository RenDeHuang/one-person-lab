import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseJsonText } from '../../../src/kernel/json-file.ts';
import { renderCodexConfigFixture } from '../../../scripts/fresh-install-codex-config-fixture.mjs';

type CodexProfileContext = {
  repoRoot: string;
  codexDefaultProfilePath: string;
  codexDefaultProfileExporterPath: string;
};

export function registerCodexProfileTests({
  repoRoot,
  codexDefaultProfilePath,
  codexDefaultProfileExporterPath,
}: CodexProfileContext) {
  test('bundled Codex profile carries the OPL Flow recommendation without runtime source checkout dependency', () => {
    const profile = parseJsonText(fs.readFileSync(codexDefaultProfilePath, 'utf8')) as {
      surface_id: string;
      version: string;
      owner: string;
      purpose: string;
      state: string;
      generated_projection: {
        source_owner: string;
        source_ref: string;
        source_field_refs: Record<string, string>;
        generator: string;
        generation_stage: string;
        runtime_source_checkout_required: boolean;
      };
      model_provider: string;
      model: string;
      model_reasoning_effort: string;
      base_url: string;
      base_url_role: string;
      model_profile_role: string;
      provider_name: string;
    };
    const serialized = JSON.stringify(profile);

    assert.equal(profile.surface_id, 'opl_codex_default_profile');
    assert.equal(profile.version, 'g2');
    assert.equal(profile.owner, 'one-person-lab');
    assert.equal(profile.purpose, 'workflow_owned_codex_install_default_projection');
    assert.equal(profile.state, 'generated_projection');
    assert.equal(profile.generated_projection.source_owner, 'opl-flow');
    assert.equal(
      profile.generated_projection.source_ref,
      'gaofeng21cn/opl-flow:contracts/workflow-policy.json#codex_model_policy',
    );
    assert.equal(
      profile.generated_projection.source_field_refs.model,
      'gaofeng21cn/opl-flow:contracts/workflow-policy.json#codex_model_policy.configured_default.model',
    );
    assert.equal(profile.generated_projection.generator, 'scripts/export-codex-default-profile.mjs');
    assert.equal(profile.generated_projection.generation_stage, 'development_or_release_sync');
    assert.equal(profile.generated_projection.runtime_source_checkout_required, false);
    assert.equal(profile.model_provider, 'oplgateway');
    assert.equal(profile.model.length > 0, true);
    assert.equal(profile.model_reasoning_effort.length > 0, true);
    assert.equal(profile.base_url, 'https://gateway.medopl.com/v1');
    assert.equal(profile.base_url_role, 'opl_base_default_provider_endpoint');
    assert.equal(profile.model_profile_role, 'opl_flow_recommendation_projection');
    assert.equal(profile.provider_name, 'OPL Gateway');
    assert.equal(serialized.includes('experimental_bearer_token'), false);
    assert.equal(serialized.toLowerCase().includes('api_key'), false);
  });

  test('Codex default profile exporter deterministically projects the OPL Flow recommendation', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-codex-default-profile-projection-'));
    const sourcePath = path.join(tempRoot, 'workflow-policy.json');
    const firstOutputPath = path.join(tempRoot, 'first.json');
    const secondOutputPath = path.join(tempRoot, 'second.json');
    const bundledProfile = parseJsonText(fs.readFileSync(codexDefaultProfilePath, 'utf8')) as {
      model_provider: string;
      model: string;
      model_reasoning_effort: string;
      provider_name: string;
      base_url: string;
    };
    const workflowPolicy = {
      schema: 'opl_flow_workflow_policy.v4',
      package: { id: 'opl-flow' },
      codex_model_policy: {
        configured_default: {
          model: bundledProfile.model,
          reasoning_effort: bundledProfile.model_reasoning_effort,
        },
      },
    };

    try {
      fs.writeFileSync(sourcePath, `${JSON.stringify(workflowPolicy, null, 2)}\n`, 'utf8');
      for (const out of [firstOutputPath, secondOutputPath]) {
        const result = spawnSync(process.execPath, [
          codexDefaultProfileExporterPath,
          '--workflow-policy', sourcePath,
          '--out', out,
        ], {
          cwd: repoRoot,
          encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
      }

      const first = fs.readFileSync(firstOutputPath, 'utf8');
      assert.equal(first, fs.readFileSync(secondOutputPath, 'utf8'));
      assert.equal(first, fs.readFileSync(codexDefaultProfilePath, 'utf8'));

      const futureModel = 'future-model';
      const futureReasoningEffort = 'future-effort';
      workflowPolicy.codex_model_policy.configured_default.model = futureModel;
      workflowPolicy.codex_model_policy.configured_default.reasoning_effort = futureReasoningEffort;
      fs.writeFileSync(sourcePath, `${JSON.stringify(workflowPolicy, null, 2)}\n`, 'utf8');
      const changed = spawnSync(process.execPath, [
        codexDefaultProfileExporterPath,
        '--workflow-policy', sourcePath,
        '--out', firstOutputPath,
      ], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      assert.equal(changed.status, 0, changed.stderr || changed.stdout);
      const changedProfile = parseJsonText(
        fs.readFileSync(firstOutputPath, 'utf8'),
      ) as typeof bundledProfile;
      const changedFixture = renderCodexConfigFixture(changedProfile);
      assert.match(changedFixture, /model = "future-model"/);
      assert.match(changedFixture, /model_reasoning_effort = "future-effort"/);

      workflowPolicy.schema = 'wrong_schema';
      fs.writeFileSync(sourcePath, `${JSON.stringify(workflowPolicy, null, 2)}\n`, 'utf8');
      const mismatch = spawnSync(process.execPath, [
        codexDefaultProfileExporterPath,
        '--workflow-policy', sourcePath,
        '--out', firstOutputPath,
      ], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      assert.notEqual(mismatch.status, 0);
      assert.match(mismatch.stderr, /schema must match opl_flow_workflow_policy.v4/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}
