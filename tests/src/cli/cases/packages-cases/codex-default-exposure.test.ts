import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { parseJsonText } from '../../../../../src/kernel/json-file.ts';
import { normalizePackageManifest } from '../../../../../src/adapters/integration/agent-package-registry-parts/manifest-normalizers.ts';

test('all package manifest normalizers preserve typed Codex default exposure', () => {
  for (const [packageId, expected] of [
    ['mas', true],
    ['mas-scholar-skills', false],
    ['opl-flow', true],
  ] as const) {
    const manifestPath = path.resolve('contracts', 'opl-framework', 'packages', `${packageId}.json`);
    const payload = parseJsonText(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    payload.rollback_ref = `rollback-ref:${packageId}/legacy`;
    const normalized = normalizePackageManifest(payload, pathToFileURL(manifestPath).href);
    assert.equal(normalized.codex_default_exposure, expected);
    assert.equal(Object.hasOwn(normalized, 'rollback_ref'), false);

    const invalid = structuredClone(payload) as Record<string, any>;
    invalid.codex_surface.codex_default_exposure = 'workspace_only';
    assert.throws(
      () => normalizePackageManifest(invalid, pathToFileURL(manifestPath).href),
      (error: any) => error?.details?.failure_code === 'agent_package_codex_default_exposure_invalid',
    );
  }
});

test('only capability Packages may declare headless internal Codex interaction', () => {
  const manifestPath = path.resolve(
    'contracts',
    'opl-framework',
    'packages',
    'opl-fleet-agent.json',
  );
  const payload = parseJsonText(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
  payload.codex_surface.interaction_mode = 'headless_internal';
  const normalized = normalizePackageManifest(payload, pathToFileURL(manifestPath).href);
  assert.equal(normalized.codex_interaction_mode, 'headless_internal');
  assert.equal(normalized.configured_codex_plugin_carrier?.interactionMode, 'headless_internal');

  const invalidValue = structuredClone(payload);
  invalidValue.codex_surface.interaction_mode = 'hidden';
  assert.throws(
    () => normalizePackageManifest(invalidValue, pathToFileURL(manifestPath).href),
    (error: any) => error?.details?.failure_code === 'agent_package_codex_interaction_mode_invalid',
  );

  const agentPath = path.resolve('contracts', 'opl-framework', 'packages', 'mas.json');
  const agentPayload = parseJsonText(fs.readFileSync(agentPath, 'utf8')) as Record<string, any>;
  agentPayload.codex_surface.interaction_mode = 'headless_internal';
  assert.throws(
    () => normalizePackageManifest(agentPayload, pathToFileURL(agentPath).href),
    (error: any) => error?.details?.failure_code === 'agent_package_codex_interaction_mode_role_invalid',
  );
});

test('internal OPL carriers stay headless while interactive Packages remain selectable', () => {
  for (const [packageId, expectedMode] of [
    ['opl-channel-weixin', 'headless_internal'],
    ['opl-link-desktop-connector', 'headless_internal'],
    ['opl-fleet-agent', 'headless_internal'],
    ['opl-flow', 'interactive'],
  ] as const) {
    const manifestPath = path.resolve('contracts', 'opl-framework', 'packages', `${packageId}.json`);
    const normalized = normalizePackageManifest(
      parseJsonText(fs.readFileSync(manifestPath, 'utf8')),
      pathToFileURL(manifestPath).href,
    );
    assert.equal(normalized.codex_interaction_mode, expectedMode, packageId);
  }
});

test('development-only connectors stay discoverable explicitly but are excluded from default registration', async () => {
  const { buildCodexFamilyPluginSpecs } = await import('../../../../../src/adapters/integration/system-installation/codex-plugin-registry.ts');
  const { getOplPackageSpecs, getPublicationAdmittedOplPackageSpecs } = await import('../../../../../src/adapters/integration/package-distribution.ts');
  const development = getOplPackageSpecs().filter(spec => spec.publication_channel_admission === 'development_only');
  assert.ok(development.some(spec => spec.package_id === 'opl-link-desktop-connector'));
  for (const spec of development) {
    assert.equal(buildCodexFamilyPluginSpecs().some(item => item.pack_id === spec.module_id), false);
    assert.equal(getPublicationAdmittedOplPackageSpecs().some(item => item.package_id === spec.package_id), false);
  }
  const descriptor = JSON.parse(fs.readFileSync('contracts/opl-framework/packages/opl-link-desktop-connector.json', 'utf8'));
  assert.equal(descriptor.app_contributions, undefined);
});
