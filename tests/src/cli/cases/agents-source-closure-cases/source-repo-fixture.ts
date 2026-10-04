import crypto from 'node:crypto';

import { fs, os, path, runCli } from '../../helpers.ts';

export function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function writeSource(repoDir: string, relativePath: string, source: string) {
  const filePath = path.join(repoDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, 'utf8');
}

export function digest(source: string) {
  return `sha256:${crypto.createHash('sha256').update(source).digest('hex')}`;
}

export function buildRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-source-closure-'));
  writeJson(path.join(repoDir, 'contracts', 'domain_descriptor.json'), {
    surface_kind: 'opl_domain_descriptor',
    domain_id: 'sample-agent',
    domain_label: 'Sample Agent',
  });
  return repoDir;
}

export function actionCatalogAction(actionId: string, executionBinding: Record<string, unknown>) {
  return {
    action_id: actionId,
    title: actionId,
    summary: `${actionId} summary`,
    owner: 'sample-agent',
    effect: 'mutating',
    execution_binding: executionBinding,
    input_schema_ref: `contracts/schemas/${actionId}.input.schema.json`,
    output_schema_ref: `contracts/schemas/${actionId}.output.schema.json`,
    required_fields: [],
    optional_fields: [],
    workspace_locator_fields: [],
    human_gate_ids: [],
    supported_surfaces: {
      cli: {},
      mcp: {},
      skill: {},
      product_entry: {},
      openai: {},
      ai_sdk: {},
    },
  };
}

export function installActionCatalog(repoDir: string, actions: Record<string, unknown>[]) {
  writeJson(path.join(repoDir, 'contracts', 'action_catalog.json'), {
    surface_kind: 'family_action_catalog',
    version: 'family-action-catalog.v2',
    catalog_id: 'sample_agent_action_catalog',
    target_domain_id: 'sample-agent',
    owner: 'sample-agent',
    authority_boundary: {
      domain_truth_owner: 'sample-agent',
      opl_role: 'projection_consumer_only',
      write_policy: 'no_domain_truth_writes',
    },
    actions,
    notes: [],
  });
}

export function installTypescriptEntry(repoDir: string, source: string) {
  writeSource(repoDir, 'src/cli.ts', source);
  writeJson(path.join(repoDir, 'package.json'), {
    name: 'sample-agent',
    version: '0.0.0',
    type: 'module',
    bin: { 'sample-agent': './src/cli.ts' },
  });
  installActionCatalog(repoDir, [
    actionCatalogAction('run', { kind: 'handler_ref', handler_ref: 'handler:run' }),
  ]);
  writeJson(path.join(repoDir, 'contracts', 'domain_handler_registry.json'), {
    surface_kind: 'domain_handler_registry',
    version: 'domain-handler-registry.v1',
    handlers: [{
      handler_id: 'run',
      binding: { kind: 'typescript_export', file: 'src/cli.ts', export: 'main' },
    }],
  });
}

export function installAudit(repoDir: string, entries: unknown[]) {
  writeJson(path.join(repoDir, 'contracts', 'source_closure_audit.json'), {
    surface_kind: 'standard_agent_source_closure_audit',
    version: 'standard-agent-source-closure-audit.v1',
    entries,
  });
}

export function runSourceClosure(repoDir: string) {
  return runCli([
    'agents',
    'source-closure',
    '--agent',
    `sample=${repoDir}`,
  ]).standard_agent_source_closure;
}
