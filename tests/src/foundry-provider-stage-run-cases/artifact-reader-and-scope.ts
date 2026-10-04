import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { scopedGatewayWorkspace } from '../foundry-kernel-cases/scoped-workspace.ts';
import { resolveFoundryExecutionScope } from '../../../src/adapters/execution/foundry-execution-scope.ts';
import { requireFamilyRuntimeExecutionScope } from '../../../src/adapters/execution/family-runtime-execution-scope.ts';
import { canonicalJsonBytes } from '../../../src/kernel/canonical-json.ts';
import {
  FileFoundryProviderArtifactReader,
  StageRunFoundryProviderInvoker,
  type FoundryProviderStageRunGateway,
} from '../../../src/adapters/execution/foundry-provider-stage-run.ts';
import { activity, provider, state } from './support.ts';

export function registerArtifactReaderAndScopeTests(): void {
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
  scopedGatewayWorkspace(t, storageRoot);
  const outside = path.join(container, 'outside.json');
  const bytes = canonicalJsonBytes({ surface_kind: 'opl_foundry_agent_blueprint' });
  fs.writeFileSync(outside, bytes);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const gateway: FoundryProviderStageRunGateway = {
    async launch() {
      return { workflow_id: 'workflow:mission-intake' };
    },
    async cancel() {},
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
    provider_source_digest: `sha256:${'a'.repeat(64)}`,
    payload: { request: { marker: 'request' } as never },
    activity,
  }), /outside the allowed immutable transport boundary/);
});

test('Foundry scope survives generation retries and rejects another run or domain binding', (t) => {
  const workspace = scopedGatewayWorkspace(t);
  const input = { provider, workspace_root: workspace, run_id: 'foundry-run-a' };
  const first = resolveFoundryExecutionScope(input);
  assert.deepEqual(resolveFoundryExecutionScope(input), first);
  const other = resolveFoundryExecutionScope({ ...input, run_id: 'foundry-run-b' });
  assert.notEqual(first.work_item_scope_id, other.work_item_scope_id);
  assert.notEqual(first.scope_digest, other.scope_digest);
  assert.throws(() => requireFamilyRuntimeExecutionScope({
    scopeKind: 'work_item', executionScope: first,
    workspaceLocator: { workspace_root: workspace, execution_scope: other },
    operation: 'cross-run-test',
  }));
  assert.throws(() => requireFamilyRuntimeExecutionScope({
    scopeKind: 'domain', executionScope: first,
    workspaceLocator: { workspace_root: workspace, execution_scope: first },
    operation: 'cross-domain-test',
  }));
  assert.throws(() => resolveFoundryExecutionScope({ ...input, provider: {
    ...provider, agent_id: 'other', package_id: 'other', domain_id: 'other',
  } }), /existing provider workspace binding/);
});
}
