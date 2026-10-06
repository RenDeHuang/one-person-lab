import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { parseJsonText } from '../../../src/kernel/json-file.ts';

type MatrixAndCleanRoomContext = {
  repoRoot: string;
  smokeScript: string;
  matrixContractPath: string;
};

export function registerMatrixAndCleanRoomTests({
  repoRoot,
  smokeScript,
  matrixContractPath,
}: MatrixAndCleanRoomContext) {
  test('fresh-install smoke runner validates local clean-room scenarios', () => {
    const result = spawnSync(process.execPath, [smokeScript], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        SHELL: process.env.SHELL || '/bin/bash',
        TMPDIR: process.env.TMPDIR || '/tmp',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseJsonText(result.stdout) as {
      surface_id: string;
      status: string;
      summary: {
        total: number;
        failed: number;
      };
      cases: Array<{ scenario_id: string; status: string }>;
    };
    assert.equal(payload.surface_id, 'opl_fresh_install_smoke');
    assert.equal(payload.status, 'passed');
    assert.equal(payload.summary.total, 5);
    assert.equal(payload.summary.failed, 0);
    assert.deepEqual(
      payload.cases.map((entry) => [entry.scenario_id, entry.status]),
      [
        ['clean_user_missing_codex', 'passed'],
        ['compatible_codex_missing_modules', 'passed'],
        ['outdated_codex', 'passed'],
        ['ready_baseline', 'passed'],
        ['offline_module_install_blocker', 'passed'],
      ],
    );
  });

  test('fresh-install matrix freezes GUI labels and first-run log contract', () => {
    const matrix = parseJsonText(fs.readFileSync(matrixContractPath, 'utf8')) as {
      surface_id: string;
      local_smoke_command: string;
      first_run_log: {
        default_path: string;
        event_schema_version: string;
        family_runtime_provider_event_types: string[];
        online_management_event_types?: string[];
      };
      gui_accessibility_labels: Record<string, string>;
      gui_vm_implementation: {
        repo: string;
        shell_root: string;
        packaged_guest_smoke_command: string;
        tart_host_smoke_command: string;
        nightly_workflow: string;
        default_self_hosted_runner_labels: string[];
      };
      scenarios: Array<{
        scenario_id: string;
        expected_artifacts?: string[];
      }>;
      ci_policy: {
        github_actions: string;
        self_hosted_macos: string;
        docker: string;
      };
    };

    assert.equal(matrix.surface_id, 'opl_fresh_install_test_matrix');
    assert.equal(matrix.local_smoke_command, 'npm run test:fresh-install');
    assert.equal(matrix.first_run_log.default_path, '~/Library/Logs/One Person Lab/first-run.jsonl');
    assert.equal(matrix.first_run_log.event_schema_version, 'opl_first_run_event.v1');
    assert.deepEqual(matrix.first_run_log.family_runtime_provider_event_types, [
      'family_runtime_provider_repair_started',
      'family_runtime_provider_repair_completed',
      'family_runtime_provider_repair_failed',
    ]);
    assert.equal(Object.hasOwn(matrix.first_run_log, 'online_management_event_types'), false);
    assert.equal(matrix.gui_accessibility_labels.window, 'opl-first-run-window');
    assert.equal(matrix.gui_accessibility_labels.install_button, 'opl-first-run-install-button');
    assert.equal(matrix.gui_accessibility_labels.codex_api_key_input, 'opl-first-run-codex-api-key-input');
    assert.equal(matrix.gui_accessibility_labels.codex_configure_button, 'opl-first-run-configure-codex-button');
    assert.equal(matrix.gui_accessibility_labels.retry_button, 'opl-first-run-retry-button');
    assert.equal(matrix.gui_accessibility_labels.guid_entry, 'opl-guid-entry');
    assert.equal(matrix.gui_vm_implementation.repo, 'gaofeng21cn/one-person-lab-app');
    assert.equal(matrix.gui_vm_implementation.shell_root, 'shells/opl-studio');
    assert.match(matrix.gui_vm_implementation.packaged_guest_smoke_command, /test:opl-first-run-vm/);
    assert.match(matrix.gui_vm_implementation.tart_host_smoke_command, /test:opl-first-run-vm:tart/);
    assert.equal(matrix.gui_vm_implementation.nightly_workflow, '.github/workflows/opl-first-run-vm.yml');
    assert.deepEqual(matrix.gui_vm_implementation.default_self_hosted_runner_labels, [
      'self-hosted',
      'macOS',
      'opl-gui-vm',
    ]);
    const cleanVmScenario = matrix.scenarios.find(
      (entry) => entry.scenario_id === 'clean_vm_release_first_launch',
    );
    assert.ok(cleanVmScenario);
    assert.equal(cleanVmScenario.expected_artifacts?.includes('connect modules JSON'), true);
    assert.equal(cleanVmScenario.expected_artifacts?.includes('modules JSON'), false);
    const [oplGithubActionsPolicy] = matrix.ci_policy.github_actions.split('. ');
    assert.match(oplGithubActionsPolicy, /local CLI fresh-install smoke/);
    assert.doesNotMatch(oplGithubActionsPolicy, /codesign\/notarization/);
    assert.match(matrix.ci_policy.github_actions, /App release workflows own codesign\/notarization/);
    assert.match(matrix.ci_policy.self_hosted_macos, /opl-first-run-vm\.yml/);
    assert.match(matrix.ci_policy.docker, /Do not use Docker/);
  });
}
