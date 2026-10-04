import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { assert, fs, os, path, repoRoot, runCli, test } from '../../helpers.ts';

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

export function runGit(repoDir: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

export function registerWorkspaceAuthority() {
  test('workspace authority does not depend on execution adapter implementation', () => {
    const workspaceRoot = path.join(repoRoot, 'src', 'authority', 'workspace');
    const pending = [workspaceRoot];
    const violations: string[] = [];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) {
        continue;
      }
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(entryPath);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          const source = fs.readFileSync(entryPath, 'utf8');
          if (/['"][^'"]*\/adapters\/execution(?:\/|['"])/u.test(source)) {
            violations.push(path.relative(repoRoot, entryPath));
          }
        }
      }
    }

    assert.deepEqual(violations, []);
  });

}

export function registerPackageActionHandlerTypescript() {
  test('agents source-closure resolves package, action, handler, and TypeScript calls', () => {
    const repoDir = buildRepo();
    const cliSource = [
      "import { handle } from './handler.ts';",
      'export function main() { return handle(); }',
      'main();',
      '',
    ].join('\n');
    installTypescriptEntry(repoDir, cliSource);
    writeSource(repoDir, 'src/handler.ts', "export function handle() { return 'ok'; }\n");

    const result = runSourceClosure(repoDir);
    const report = result.reports[0];

    assert.equal(result.status, 'passed');
    assert.equal(report.scan_complete, true);
    assert.deepEqual(
      new Set(report.entrypoints.map((entry: { source_kind: string }) => entry.source_kind)),
      new Set(['package_bin', 'action_catalog', 'handler_registry']),
    );
    assert.equal(report.reachable_symbols.some((symbol: { symbol: string }) => symbol.symbol === 'handle'), true);
  });

}

export function registerNestedWorkspaceBins() {
  test('agents source-closure discovers nested workspace package bins', () => {
    const repoDir = buildRepo();
    writeJson(path.join(repoDir, 'package.json'), {
      name: 'sample-monorepo',
      version: '0.0.0',
      private: true,
      workspaces: ['apps/*'],
    });
    writeJson(path.join(repoDir, 'apps', 'sample-cli', 'package.json'), {
      name: '@sample/cli',
      version: '0.0.0',
      type: 'module',
      bin: { sample: 'dist/cli.js' },
    });
    writeSource(repoDir, 'apps/sample-cli/src/cli.ts', [
      "export function main() { return 'ok'; }",
      'main();',
      '',
    ].join('\n'));

    const report = runSourceClosure(repoDir).reports[0];
    const nestedBin = report.entrypoints.find((entry: { entrypoint_id: string }) => (
      entry.entrypoint_id === 'package_bin:apps/sample-cli/package.json#sample'
    ));

    assert.equal(report.status, 'passed');
    assert.equal(nestedBin?.declared_ref, 'apps/sample-cli/package.json#/bin/sample');
    assert.equal(nestedBin?.file, 'apps/sample-cli/src/cli.ts');
    assert.equal(nestedBin?.resolution_status, 'resolved');
  });

}

export function registerNestedWorkspaceExports() {
  test('agents source-closure discovers nested workspace package exports', () => {
    const repoDir = buildRepo();
    writeJson(path.join(repoDir, 'package.json'), {
      name: 'sample-monorepo',
      version: '0.0.0',
      private: true,
      workspaces: ['packages/*'],
    });
    writeJson(path.join(repoDir, 'packages', 'sample-domain', 'package.json'), {
      name: '@sample/domain',
      version: '0.0.0',
      type: 'module',
      exports: { '.': './dist/index.js' },
    });
    writeSource(repoDir, 'packages/sample-domain/src/index.ts', [
      "export { handle } from './handler.js';",
      '',
    ].join('\n'));
    writeSource(repoDir, 'packages/sample-domain/src/handler.ts', [
      "export function handle() { return 'ok'; }",
      '',
    ].join('\n'));

    const report = runSourceClosure(repoDir).reports[0];
    const packageExport = report.entrypoints.find((entry: { entrypoint_id: string }) => (
      entry.entrypoint_id === 'package_export:packages/sample-domain/package.json#.'
    ));

    assert.equal(report.status, 'passed');
    assert.equal(packageExport?.declared_ref, 'packages/sample-domain/package.json#/exports/.');
    assert.equal(packageExport?.file, 'packages/sample-domain/src/index.ts');
    assert.equal(packageExport?.resolution_status, 'resolved');
    assert.equal(
      report.reachable_symbols.some((symbol: { symbol: string }) => symbol.symbol === 'handle'),
      true,
    );
  });

}

export function registerTypescriptDynamicImportDispatch() {
  test('agents source-closure fails closed on dynamic import and dispatch', () => {
    const repoDir = buildRepo();
    installTypescriptEntry(repoDir, [
      'export async function main(name: string) {',
      '  const loaded = await import(name);',
      '  return loaded[name]();',
      '}',
      "void main(process.argv[2] ?? './handler.ts');",
      '',
    ].join('\n'));

    const report = runSourceClosure(repoDir).reports[0];
    const reasons = report.unresolved_edges.map((edge: { reason: string }) => edge.reason);

    assert.equal(report.status, 'blocked');
    assert.equal(reasons.includes('dynamic_import'), true);
    assert.equal(reasons.includes('dynamic_dispatch'), true);
  });

}

export function registerHostedStageBindings() {
  test('agents source-closure accepts canonical OPL-hosted stage bindings', () => {
    const repoDir = buildRepo();
    writeJson(path.join(repoDir, 'agent', 'stages', 'manifest.json'), {
      surface_kind: 'family_stage_manifest',
    });
    installActionCatalog(repoDir, [{
      ...actionCatalogAction('hosted', {
        kind: 'stage_binding',
        stage_manifest_ref: 'agent/stages/manifest.json',
      }),
      stage_route: {
        entry_stage_ref: 'sample-stage',
        required_stage_refs: ['sample-stage'],
        optional_stage_refs: [],
        terminal_stage_refs: ['sample-stage'],
        route_policy: 'ai_selected_progress_route',
      },
    }]);

    const report = runSourceClosure(repoDir).reports[0];

    assert.equal(report.status, 'passed');
    assert.equal(
      report.entrypoints.some((entry: { entrypoint_id: string; resolution_status: string }) =>
        entry.entrypoint_id === 'action_catalog:hosted' && entry.resolution_status === 'resolved'
      ),
      true,
    );
  });

}

export function registerMissingStageAndHandler() {
  test('agents source-closure blocks missing stage manifests and unresolved handler refs', () => {
    const repoDir = buildRepo();
    installActionCatalog(repoDir, [
      {
        ...actionCatalogAction('hosted', {
          kind: 'stage_binding',
          stage_manifest_ref: 'agent/stages/manifest.json',
        }),
        stage_route: {
          entry_stage_ref: 'sample-stage',
          required_stage_refs: ['sample-stage'],
          optional_stage_refs: [],
          terminal_stage_refs: ['sample-stage'],
          route_policy: 'ai_selected_progress_route',
        },
      },
      actionCatalogAction('missing-handler', {
        kind: 'handler_ref',
        handler_ref: 'handler:missing-handler',
      }),
    ]);

    const report = runSourceClosure(repoDir).reports[0];

    assert.equal(report.status, 'blocked');
    assert.equal(
      report.entrypoints.some((entry: { entrypoint_id: string; resolution_status: string }) =>
        entry.entrypoint_id === 'action_catalog:hosted'
        && entry.resolution_status === 'hosted_declaration_unverified'
      ),
      true,
    );
    assert.equal(
      report.entrypoints.some((entry: { entrypoint_id: string; resolution_status: string }) =>
        entry.entrypoint_id === 'action_handler:missing-handler'
        && entry.resolution_status === 'unresolved'
      ),
      true,
    );
  });

}

export function registerDirtyWorkspaceBytes() {
  test('agents source-closure scans current dirty workspace bytes including untracked replacements', () => {
    const repoDir = buildRepo();
    const oldCli = [
      "import { handle } from './old-handler.ts';",
      'export function main() { return handle(); }',
      'main();',
      '',
    ].join('\n');
    installTypescriptEntry(repoDir, oldCli);
    writeSource(repoDir, 'src/old-handler.ts', "export function handle() { return 'old'; }\n");
    writeJson(path.join(repoDir, 'contracts', 'domain_handler_registry.json'), {
      surface_kind: 'domain_handler_registry',
      version: 'domain-handler-registry.v1',
      handlers: [{
        handler_id: 'run',
        binding: { kind: 'typescript_export', file: 'src/old-handler.ts', export: 'handle' },
      }],
    });
    runGit(repoDir, ['init', '-q']);
    runGit(repoDir, ['add', '.']);

    fs.rmSync(path.join(repoDir, 'src', 'old-handler.ts'));
    writeSource(repoDir, 'src/cli.ts', [
      "import { handleReplacement } from './replacement-handler.ts';",
      'export function main() { return handleReplacement(); }',
      'main();',
      '',
    ].join('\n'));
    writeSource(
      repoDir,
      'src/replacement-handler.ts',
      "export function handleReplacement() { return 'new'; }\n",
    );
    fs.symlinkSync(
      'replacement-handler.ts',
      path.join(repoDir, 'src', 'linked-handler.ts'),
    );
    writeJson(path.join(repoDir, 'contracts', 'domain_handler_registry.json'), {
      surface_kind: 'domain_handler_registry',
      version: 'domain-handler-registry.v1',
      handlers: [{
        handler_id: 'run',
        binding: {
          kind: 'typescript_export',
          file: 'src/replacement-handler.ts',
          export: 'handleReplacement',
        },
      }],
    });

    const report = runSourceClosure(repoDir).reports[0];

    assert.equal(report.status, 'passed');
    assert.equal(Object.hasOwn(report.source_digests, 'src/old-handler.ts'), false);
    assert.equal(Object.hasOwn(report.source_digests, 'src/replacement-handler.ts'), true);
    assert.equal(Object.hasOwn(report.source_digests, 'src/linked-handler.ts'), false);
    assert.equal(
      report.reachable_symbols.some((symbol: { symbol: string }) => symbol.symbol === 'handleReplacement'),
      true,
    );
  });
}
