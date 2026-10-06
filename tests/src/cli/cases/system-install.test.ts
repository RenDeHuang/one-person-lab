import { assert, contractsDir, createCodexConfigFixture, fs, loadFrameworkContracts, os, path, runCli, runCliFailure, test } from '../helpers.ts';
import { buildInternalCommandSpecs } from '../../../../src/entrypoints/cli/cases/private-command-specs.ts';
import { buildPublicCommandSpecs } from '../../../../src/entrypoints/cli/cases/public-command-specs.ts';
import { createCordisBaseHeadlessComposition } from '../../../../src/host/composition-profiles.ts';
import { parseTurnkeyInstallArgs } from '../../../../src/entrypoints/cli/modules/support.ts';
import {
  OPL_GATEWAY_BASE_URL,
  OPL_GATEWAY_LEGACY_BASE_URLS,
  readBundledCodexDefaultProfile,
} from '../../../../src/kernel/local-codex-defaults.ts';
import { listDefaultOplDomainModuleSpecs } from '../../../../src/adapters/integration/system-installation/modules.ts';
import { createFakeCompanionInstallEnv } from './system-install-fixtures.ts';

function disableRemoteCompanionInstall() {
  return {
    OPL_COMPANION_DISABLE_REMOTE_INSTALL: '1',
  };
}

function createFakeNativeHelperRepairEnv(homeRoot: string) {
  const helperBinDir = path.join(homeRoot, 'native-bin');
  const repairScript = path.join(homeRoot, 'repair-native.sh');
  fs.writeFileSync(
    repairScript,
    `#!/bin/sh
set -eu
mkdir -p ${JSON.stringify(helperBinDir)}
for binary in opl-doctor-native opl-runtime-watch opl-artifact-indexer opl-state-indexer; do
  cat > ${JSON.stringify(helperBinDir)}/$binary <<'EOS'
#!/bin/sh
cat >/dev/null
case "$(basename "$0")" in
  opl-doctor-native) printf '%s\\n' '{"protocol_version":"opl_native_helper.v1","helper_id":"opl-doctor-native","ok":true,"request_id":"headless-doctor","result":{"surface_kind":"native_doctor_snapshot"},"errors":[]}' ;;
  opl-runtime-watch) printf '%s\\n' '{"protocol_version":"opl_native_helper.v1","helper_id":"opl-runtime-watch","ok":true,"request_id":"headless-watch","result":{"surface_kind":"runtime_health_snapshot_index","roots":[]},"errors":[]}' ;;
  opl-artifact-indexer) printf '%s\\n' '{"protocol_version":"opl_native_helper.v1","helper_id":"opl-artifact-indexer","ok":true,"request_id":"headless-artifacts","result":{"surface_kind":"native_artifact_manifest","summary":{"total_files_count":0},"files":[]},"errors":[]}' ;;
  opl-state-indexer) printf '%s\\n' '{"protocol_version":"opl_native_helper.v1","helper_id":"opl-state-indexer","ok":true,"request_id":"headless-state","result":{"surface_kind":"native_state_index","roots":[],"json_validation":{"checked_files_count":0,"invalid_files_count":0,"files":[]}},"errors":[]}' ;;
esac
EOS
  chmod +x ${JSON.stringify(helperBinDir)}/$binary
done
`,
    { mode: 0o755 },
  );
  return {
    OPL_NATIVE_HELPER_BIN_DIR: helperBinDir,
    OPL_NATIVE_HELPER_REPAIR_COMMAND: repairScript,
  };
}

const codexDefaultProfile = readBundledCodexDefaultProfile();

function assertBundledCodexModel(bootstrap: any, config: string) {
  assert.equal(bootstrap.model, codexDefaultProfile.model);
  assert.equal(bootstrap.reasoning_effort, codexDefaultProfile.model_reasoning_effort);
  assert.equal(config.includes(`model = ${JSON.stringify(codexDefaultProfile.model)}`), true);
  assert.equal(
    config.includes(
      `model_reasoning_effort = ${JSON.stringify(codexDefaultProfile.model_reasoning_effort)}`,
    ),
    true,
  );
}

test('public command specs expose the one-shot install command', async () => {
  const contracts = loadFrameworkContracts({ contractsDir });
  const composition = await createCordisBaseHeadlessComposition();
  try {
    const internalSpecs = buildInternalCommandSpecs(
      {
        helpRequested: false,
        jsonOutput: true,
        textOutput: false,
        command: null,
        args: [],
        loadOptions: { contractsDir },
      },
      () => contracts,
      composition,
    );
    const publicSpecs = buildPublicCommandSpecs(internalSpecs, () => contracts, composition);

    assert.equal(typeof publicSpecs.install.handler, 'function');
    assert.deepEqual(parseTurnkeyInstallArgs([], publicSpecs.install), { headless: true });
    assert.deepEqual(parseTurnkeyInstallArgs(['--with-app'], publicSpecs.install), {
      headless: false,
      withApp: true,
    });
    assert.throws(
      () => parseTurnkeyInstallArgs(['--headless', '--with-app'], publicSpecs.install),
      /--headless and --with-app are mutually exclusive\./,
    );
  } finally {
    await composition.dispose();
  }
});

test('install rejects the retired --skip-modules alias', () => {
  const failure = runCliFailure(['install', '--skip-modules']);
  assert.equal(failure.payload.error.code, 'cli_usage_error');
  assert.match(failure.payload.error.message, /Unknown option '--skip-modules'/);
  assert.equal(failure.payload.error.details.parser_adapter, 'node_util_parse_args');
});

test('ScholarSkills is dependency-managed and is not a global default module', () => {
  assert.equal(
    listDefaultOplDomainModuleSpecs().some((module) => module.module_id === 'scholarskills'),
    false,
  );
});

test('install rejects retired --modules and --module package selection flags', () => {
  for (const args of [
    ['install', '--modules', 'rca'],
    ['install', '--module', 'redcube'],
  ]) {
    const failure = runCliFailure(args);
    assert.equal(failure.payload.error.code, 'cli_usage_error');
    assert.match(failure.payload.error.message, /Unknown option/);
    assert.equal(failure.payload.error.details.parser_adapter, 'node_util_parse_args');
  }
});

test('install parser reports standard node parseArgs errors for positionals and boolean values', () => {
  const positionalFailure = runCliFailure(['install', 'package-id']);
  assert.match(positionalFailure.payload.error.message, /Unexpected argument 'package-id'/);
  assert.equal(positionalFailure.payload.error.details.parser_adapter, 'node_util_parse_args');

  const booleanValueFailure = runCliFailure(['install', '--headless=true']);
  assert.match(booleanValueFailure.payload.error.message, /Option '--headless' does not take an argument/);
  assert.equal(booleanValueFailure.payload.error.details.parser_adapter, 'node_util_parse_args');
});

test('install defaults to headless Base and delegates Agent installation to opl packages', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-base-install-home-'));
  try {
    const output = runCli([
      'install',
      '--headless',
      '--skip-packages',
      '--skip-engines',
      '--skip-native-helper-repair',
    ], {
      HOME: homeRoot,
      CODEX_HOME: path.join(homeRoot, 'codex-home'),
      OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      OPL_MODULES_ROOT: path.join(homeRoot, 'managed-modules'),
      ...disableRemoteCompanionInstall(),
    }) as any;

    assert.equal(output.install.status, 'completed');
    assert.equal(output.install.install_mode, 'headless');
    assert.deepEqual(output.install.selected_packages, []);
    assert.deepEqual(output.install.package_installation, {
      owner: 'opl_packages',
      performed_by_turnkey: false,
      explicit_command: 'opl packages install <package_id>',
      skip_packages_requested: true,
    });
    assert.equal(Object.hasOwn(output.install, 'selected_modules'), false);
    assert.equal(Object.hasOwn(output.install, 'module_actions'), false);
    assert.equal(Object.hasOwn(output.install, 'codex_plugin_registry'), false);
    assert.equal(fs.existsSync(path.join(homeRoot, 'managed-modules')), false);
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('companion commands do not invent defaults without an installed OPL Flow policy', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-no-flow-companion-noop-home-'));
  const env = createFakeCompanionInstallEnv(homeRoot);
  try {
    const applied = runCli(['skill', 'companion', 'apply', '--mode', 'managed'], {
      HOME: homeRoot,
      CODEX_HOME: path.join(homeRoot, 'codex-home'),
      OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      PATH: '/usr/bin:/bin',
      ...env,
    }) as any;
    assert.deepEqual(applied.companion_skills.items, []);
    assert.deepEqual(applied.companion_skills.tools, []);
    assert.equal(fs.existsSync(path.join(homeRoot, 'codex-home', 'skills')), false);

    const initialized = runCli(['system', 'initialize'], {
      HOME: homeRoot,
      CODEX_HOME: path.join(homeRoot, 'codex-home'),
      OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      PATH: '/usr/bin:/bin',
    }) as any;
    assert.deepEqual(initialized.system_initialize.recommended_skills.skills, []);
    assert.deepEqual(initialized.system_initialize.recommended_skills.summary, { total: 0, ready: 0, missing: 0 });
    const checklist = initialized.system_initialize.checklist.find((entry: any) => entry.item_id === 'recommended_skills');
    assert.equal(checklist.status, 'ready');
    assert.equal(checklist.severity, 'info');
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('recommended system companion skills exclude MAS/MDS project-local stage skills', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-install-mds-stage-skills-home-'));

  try {
    const output = runCli(['system', 'initialize'], {
      HOME: homeRoot,
      CODEX_HOME: path.join(homeRoot, 'codex-home'),
      OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      PATH: '/usr/bin:/bin',
    }) as any;

    const skillIds = output.system_initialize.recommended_skills.skills.map((skill: any) => skill.skill_id);
    for (const stageSkillId of ['deepscientist', 'scout', 'finalize', 'write', 'review', 'baseline']) {
      assert.equal(skillIds.includes(stageSkillId), false);
    }
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('managed companion sync does not mirror MAS/MDS project-local stage skills into user Codex home', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-companion-mds-stage-skills-home-'));

  try {
    const output = runCli([
      'skill',
      'companion',
      'apply',
      '--mode',
      'managed',
    ], {
      HOME: homeRoot,
      CODEX_HOME: path.join(homeRoot, 'codex-home'),
      OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      ...disableRemoteCompanionInstall(),
    }) as any;

    const skillIds = output.companion_skills.items.map((item: any) => item.skill_id);
    for (const stageSkillId of ['deepscientist', 'scout', 'finalize', 'write', 'review', 'baseline']) {
      assert.equal(skillIds.includes(stageSkillId), false);
      assert.equal(fs.existsSync(path.join(homeRoot, 'codex-home', 'skills', stageSkillId, 'SKILL.md')), false);
    }
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('install command repairs native helpers and returns the refreshed lifecycle report', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-install-native-home-'));
  const helperBinDir = path.join(homeRoot, 'native-bin');
  const repairScript = path.join(homeRoot, 'repair-native.sh');
  fs.mkdirSync(helperBinDir, { recursive: true });
  fs.writeFileSync(
    repairScript,
    `#!/bin/sh
set -eu
for binary in opl-doctor-native opl-runtime-watch opl-artifact-indexer opl-state-indexer; do
  cat > "${helperBinDir}/$binary" <<'EOS'
#!/bin/sh
cat >/dev/null
case "$(basename "$0")" in
  opl-doctor-native)
    printf '%s\\n' '{"protocol_version":"opl_native_helper.v1","helper_id":"opl-doctor-native","ok":true,"request_id":"runtime-manager-doctor","result":{"surface_kind":"native_doctor_snapshot"},"errors":[]}'
    ;;
  opl-runtime-watch)
    printf '%s\\n' '{"protocol_version":"opl_native_helper.v1","helper_id":"opl-runtime-watch","ok":true,"request_id":"runtime-manager-runtime-watch","result":{"surface_kind":"runtime_health_snapshot_index","roots":[]},"errors":[]}'
    ;;
  opl-artifact-indexer)
    printf '%s\\n' '{"protocol_version":"opl_native_helper.v1","helper_id":"opl-artifact-indexer","ok":true,"request_id":"runtime-manager-artifact-index","result":{"surface_kind":"native_artifact_manifest","summary":{"total_files_count":0},"files":[]},"errors":[]}'
    ;;
  opl-state-indexer)
    printf '%s\\n' '{"protocol_version":"opl_native_helper.v1","helper_id":"opl-state-indexer","ok":true,"request_id":"runtime-manager-state-index","result":{"surface_kind":"native_state_index","roots":[],"json_validation":{"checked_files_count":0,"invalid_files_count":0,"files":[]}},"errors":[]}'
    ;;
esac
EOS
  chmod +x "${helperBinDir}/$binary"
done
printf 'native repair completed\\n'
`,
    { mode: 0o755 },
  );

  try {
    const output = runCli(['install', '--skip-packages', '--skip-engines', '--headless'], {
      HOME: homeRoot,
      OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      OPL_NATIVE_HELPER_BIN_DIR: helperBinDir,
      OPL_NATIVE_HELPER_REPAIR_COMMAND: repairScript,
      ...disableRemoteCompanionInstall(),
    }) as any;

    assert.equal(output.install.native_helper_action.action, 'repair_native_helpers');
    assert.equal(output.install.native_helper_action.status, 'completed');
    assert.deepEqual(output.install.native_helper_action.command_preview, [repairScript]);
    assert.equal(output.install.native_helper_action.before.runtime.status, 'unavailable');
    assert.equal(output.install.native_helper_action.after.runtime.status, 'available');
    assert.equal(output.install.system_initialize.native_helpers.runtime.status, 'available');
    assert.equal(output.install.system_initialize.native_helpers.health_status, 'ready');
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('install command can bootstrap Codex defaults from environment without leaking the API key', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-install-codex-defaults-home-'));

  try {
    const output = runCli(['install', '--skip-packages', '--skip-engines', '--headless', '--skip-native-helper-repair'], {
      HOME: homeRoot,
      CODEX_HOME: path.join(homeRoot, 'codex-home'),
      OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      OPL_CODEX_MODEL: 'gpt-5.5',
      OPL_CODEX_REASONING_EFFORT: 'xhigh',
      OPL_CODEX_BASE_URL: 'https://codex-provider.example.test/v1',
      OPL_CODEX_API_KEY: 'secret-test-key',
      ...disableRemoteCompanionInstall(),
    }) as any;

    const bootstrap = output.install.codex_config_bootstrap;
    assert.equal(bootstrap.status, 'completed');
    assert.equal(bootstrap.model, 'gpt-5.5');
    assert.equal(bootstrap.reasoning_effort, 'xhigh');
    assert.equal(bootstrap.provider_base_url, 'https://codex-provider.example.test/v1');
    assert.equal(bootstrap.api_key_present, true);
    assert.equal(JSON.stringify(output).includes('secret-test-key'), false);

    const config = fs.readFileSync(bootstrap.config_path, 'utf8');
    assert.match(config, /model = "gpt-5\.5"/);
    assert.match(config, /model_reasoning_effort = "xhigh"/);
    assert.match(config, /base_url = "https:\/\/codex-provider\.example\.test\/v1"/);
    assert.match(config, /experimental_bearer_token = "secret-test-key"/);
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('install command applies bundled Codex defaults when only the API key is provided', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-install-bundled-codex-defaults-home-'));

  try {
    const output = runCli(['install', '--skip-packages', '--skip-engines', '--headless', '--skip-native-helper-repair'], {
      HOME: homeRoot,
      CODEX_HOME: path.join(homeRoot, 'codex-home'),
      OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      OPL_CODEX_MODEL: '',
      CODEX_MODEL: '',
      OPL_CODEX_REASONING_EFFORT: '',
      CODEX_REASONING_EFFORT: '',
      OPL_CODEX_API_KEY: 'secret-test-key',
      ...disableRemoteCompanionInstall(),
    }) as any;

    const bootstrap = output.install.codex_config_bootstrap;
    const config = fs.readFileSync(bootstrap.config_path, 'utf8');
    assertBundledCodexModel(bootstrap, config);
    assert.match(config, /name = "OPL Gateway"/);
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('install command upgrades an existing OPL Gateway alias while preserving its token', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-install-existing-opl-defaults-home-'));
  const codexHome = path.join(homeRoot, 'codex-home');
  const configPath = path.join(codexHome, 'config.toml');

  try {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        'model_provider = "company-opl"',
        'model = "gpt-5.5"',
        'model_reasoning_effort = "xhigh"',
        'custom_user_setting = true',
        '',
        '[model_providers.company-opl]',
        'name = "Company OPL Gateway"',
        `base_url = "${OPL_GATEWAY_LEGACY_BASE_URLS[0]}"`,
        'experimental_bearer_token = "existing-opl-key"',
        'wire_api = "responses"',
        'custom_header = "preserve-me"',
        '',
      ].join('\n'),
      'utf8',
    );

    const output = runCli(['install', '--skip-packages', '--skip-engines', '--headless', '--skip-native-helper-repair'], {
      HOME: homeRoot,
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: 'ambient-openai-key-must-not-replace-provider-token',
      OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      ...disableRemoteCompanionInstall(),
    }) as any;

    const bootstrap = output.install.codex_config_bootstrap;
    assert.equal(bootstrap.status, 'completed');
    assert.equal(bootstrap.management_receipt.provider_id, 'company-opl');
    assert.equal(bootstrap.management_receipt.provider_route, 'direct_gateway');
    assert.equal(bootstrap.management_receipt.selection_mode, 'auto');

    const config = fs.readFileSync(configPath, 'utf8');
    assert.match(config, /model_provider = "company-opl"/);
    assertBundledCodexModel(bootstrap, config);
    assert.match(config, /custom_user_setting = true/);
    assert.match(config, /name = "Company OPL Gateway"/);
    assert.match(config, /base_url = "https:\/\/gflabtoken\.cn\/v1"/);
    assert.match(config, /experimental_bearer_token = "existing-opl-key"/);
    assert.doesNotMatch(config, /ambient-openai-key-must-not-replace-provider-token/);
    assert.match(config, /wire_api = "responses"/);
    assert.match(config, /custom_header = "preserve-me"/);

    runCli(['install', '--skip-packages', '--skip-engines', '--headless', '--skip-native-helper-repair'], {
      HOME: homeRoot,
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: 'ambient-openai-key-must-not-replace-provider-token',
      OPL_CODEX_API_KEY: 'explicit-opl-environment-key',
      OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      ...disableRemoteCompanionInstall(),
    });
    const updatedConfig = fs.readFileSync(configPath, 'utf8');
    assert.match(updatedConfig, /experimental_bearer_token = "explicit-opl-environment-key"/);
    assert.doesNotMatch(updatedConfig, /ambient-openai-key-must-not-replace-provider-token/);
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('install command preserves the legacy gflab provider name for existing conversation affinity', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-install-existing-gflab-name-home-'));
  const codexHome = path.join(homeRoot, 'codex-home');
  const configPath = path.join(codexHome, 'config.toml');

  try {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        'model_provider = "gflab"',
        'model = "gpt-5.5"',
        'model_reasoning_effort = "xhigh"',
        '',
        '[model_providers.gflab]',
        'name = "gflab"',
        `base_url = "${OPL_GATEWAY_LEGACY_BASE_URLS[0]}"`,
        'experimental_bearer_token = "existing-opl-key"',
        '',
      ].join('\n'),
      'utf8',
    );

    const output = runCli(['install', '--skip-packages', '--skip-engines', '--headless', '--skip-native-helper-repair'], {
      HOME: homeRoot,
      CODEX_HOME: codexHome,
      OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      ...disableRemoteCompanionInstall(),
    }) as any;

    assert.equal(output.install.codex_config_bootstrap.status, 'completed');
    const config = fs.readFileSync(configPath, 'utf8');
    assert.match(config, /model_provider = "gflab"/);
    assert.match(config, /\[model_providers\.gflab\]/);
    assert.match(config, /^name = "gflab"$/m);
    assert.match(config, /base_url = "https:\/\/gflabtoken\.cn\/v1"/);
    assert.doesNotMatch(config, /^name = "OPL Gateway"$/m);
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('install command does not upgrade a direct OPL Gateway config without a bearer token', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-install-tokenless-direct-gateway-home-'));
  const codexHome = path.join(homeRoot, 'codex-home');
  const configPath = path.join(codexHome, 'config.toml');

  try {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        'model_provider = "gflab"',
        'model = "gpt-5.5"',
        'model_reasoning_effort = "xhigh"',
        '',
        '[model_providers.gflab]',
        'name = "gflab"',
        `base_url = "${OPL_GATEWAY_LEGACY_BASE_URLS[0]}"`,
        '',
      ].join('\n'),
      'utf8',
    );

    const output = runCli(['install', '--skip-packages', '--skip-engines', '--headless', '--skip-native-helper-repair'], {
      HOME: homeRoot,
      CODEX_HOME: codexHome,
      OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      ...disableRemoteCompanionInstall(),
    }) as any;

    assert.equal(output.install.codex_config_bootstrap.status, 'skipped_missing_input');
    assert.equal(output.install.codex_config_bootstrap.api_key_present, false);
    const config = fs.readFileSync(configPath, 'utf8');
    assert.match(config, /model = "gpt-5\.5"/);
    assert.match(config, /model_reasoning_effort = "xhigh"/);
    assert.doesNotMatch(config, /experimental_bearer_token/);
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('install command treats oplgateway as the OPL-owned stable id and updates it in place', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-install-oplgateway-collision-home-'));
  const codexHome = path.join(homeRoot, 'codex-home');
  const configPath = path.join(codexHome, 'config.toml');

  try {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        'model_provider = "oplgateway"',
        'model = "third-party-model"',
        'model_reasoning_effort = "medium"',
        '',
        '[model_providers.oplgateway]',
        'name = "Stale OPL Gateway"',
        'base_url = "https://third-party.example.test/v1"',
        'experimental_bearer_token = "third-party-key"',
        '',
      ].join('\n'),
      'utf8',
    );

    const output = runCli(['install', '--skip-packages', '--skip-engines', '--headless', '--skip-native-helper-repair'], {
      HOME: homeRoot,
      CODEX_HOME: codexHome,
      OPL_CODEX_API_KEY: 'new-opl-key',
      OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      ...disableRemoteCompanionInstall(),
    }) as any;

    const bootstrap = output.install.codex_config_bootstrap;
    assert.equal(bootstrap.status, 'completed');
    assert.equal(bootstrap.model, 'third-party-model');
    assert.equal(bootstrap.reasoning_effort, 'medium');
    assert.equal(bootstrap.management_receipt.selection_mode, 'auto');
    assert.equal(bootstrap.management_receipt.provider_route, 'direct_gateway');
    assert.equal(bootstrap.management_receipt.provider_id, 'oplgateway');
    const config = fs.readFileSync(configPath, 'utf8');
    assert.match(config, /model_provider = "oplgateway"/);
    assert.match(config, /model = "third-party-model"/);
    assert.match(config, /\[model_providers\.oplgateway\]/);
    assert.match(config, /name = "OPL Gateway"/);
    assert.match(config, /base_url = "https:\/\/gateway\.medopl\.com\/v1"/);
    assert.match(config, /experimental_bearer_token = "new-opl-key"/);
    assert.doesNotMatch(config, /third-party\.example\.test|third-party-key/);
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('base install completes without installing optional packages', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-install-base-only-home-'));

  try {
    const output = runCli(['install', '--skip-packages', '--skip-engines', '--headless', '--skip-native-helper-repair'], {
      HOME: homeRoot,
      CODEX_HOME: path.join(homeRoot, 'codex-home'),
      OPL_MODULES_ROOT: path.join(homeRoot, 'missing-modules'),
      OPL_CODEX_API_KEY: 'must-not-be-written-before-flow-preflight',
      OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      ...disableRemoteCompanionInstall(),
    }) as any;

    assert.equal(output.install.status, 'completed');
    assert.equal(fs.existsSync(path.join(homeRoot, 'codex-home', 'config.toml')), true);
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});
test('system initialize blocks launch when compatible Codex CLI lacks configured API key', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-initialize-codex-config-home-'));
  const codexFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-initialize-codex-config-bin-'));
  const codexPath = path.join(codexFixtureRoot, 'codex');
  fs.writeFileSync(codexPath, '#!/usr/bin/env bash\necho "codex-cli 0.125.0"\n', { mode: 0o755 });

  try {
    const output = runCli(['system', 'initialize'], {
      HOME: homeRoot,
      CODEX_HOME: path.join(homeRoot, 'codex-home'),
      OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      PATH: `${codexFixtureRoot}:/usr/bin:/bin`,
    }) as any;

    assert.equal(output.system_initialize.setup_flow.phase, 'environment');
    assert.equal(output.system_initialize.setup_flow.ready_to_launch, false);
    assert.equal(output.system_initialize.setup_flow.blocking_items.includes('codex_config'), true);
    const codexConfigItem = output.system_initialize.checklist.find((entry: any) => entry.item_id === 'codex_config');
    assert.equal(codexConfigItem?.blocking, true);
    assert.equal(codexConfigItem?.readiness_layer, 'core_launch');
    assert.equal(codexConfigItem?.severity, 'blocking');
    assert.equal(codexConfigItem?.action_command_ref, 'opl system configure-codex --api-key-stdin');
    assert.equal(output.system_initialize.core_engines.codex.config_status, 'not_detected');
    assert.equal(output.system_initialize.core_engines.codex.api_key_present, false);
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.rmSync(codexFixtureRoot, { recursive: true, force: true });
  }
});

test('system initialize accepts existing Codex login without OPL Gateway API key', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-initialize-codex-login-home-'));
  const codexHome = path.join(homeRoot, 'codex-home');
  const codexFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-initialize-codex-login-bin-'));
  const codexPath = path.join(codexFixtureRoot, 'codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(codexPath, '#!/usr/bin/env bash\necho "codex-cli 0.125.0"\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(codexHome, 'auth.json'),
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'redacted-test-token' } }),
    'utf8',
  );

  try {
    const output = runCli(['system', 'initialize'], {
      HOME: homeRoot,
      CODEX_HOME: codexHome,
      OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      PATH: `${codexFixtureRoot}:/usr/bin:/bin`,
    }) as any;

    assert.equal(output.system_initialize.setup_flow.ready_to_launch, true);
    assert.equal(output.system_initialize.setup_flow.blocking_items.includes('codex_config'), false);
    const codexConfigItem = output.system_initialize.checklist.find((entry: any) => entry.item_id === 'codex_config');
    assert.equal(codexConfigItem?.blocking, false);
    assert.match(codexConfigItem?.detail_summary ?? '', /Using existing Codex model access/);
    assert.equal(output.system_initialize.core_engines.codex.api_key_present, false);
    assert.equal(output.system_initialize.core_engines.codex.opl_gateway_configured, false);
    assert.equal(output.system_initialize.core_engines.codex.model_access_ready, true);
    assert.equal(output.system_initialize.core_engines.codex.model_access_source, 'codex_login');
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.rmSync(codexFixtureRoot, { recursive: true, force: true });
  }
});

test('system initialize accepts environment API key model access without local Codex config', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-initialize-env-key-home-'));
  const codexFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-initialize-env-key-bin-'));
  const codexPath = path.join(codexFixtureRoot, 'codex');
  fs.writeFileSync(codexPath, '#!/usr/bin/env bash\necho "codex-cli 0.125.0"\n', { mode: 0o755 });

  try {
    const output = runCli(['system', 'initialize'], {
      HOME: homeRoot,
      CODEX_HOME: path.join(homeRoot, 'codex-home'),
      OPENAI_API_KEY: 'redacted-env-key',
      OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      PATH: `${codexFixtureRoot}:/usr/bin:/bin`,
    }) as any;

    assert.equal(output.system_initialize.setup_flow.ready_to_launch, true);
    assert.equal(output.system_initialize.setup_flow.blocking_items.includes('codex_config'), false);
    assert.equal(output.system_initialize.core_engines.codex.api_key_present, false);
    assert.equal(output.system_initialize.core_engines.codex.opl_gateway_configured, false);
    assert.equal(output.system_initialize.core_engines.codex.model_access_ready, true);
    assert.equal(output.system_initialize.core_engines.codex.model_access_source, 'env_api_key');
    assert.equal(output.system_initialize.core_engines.codex.env_api_key_present, true);
    assert.equal(JSON.stringify(output).includes('redacted-env-key'), false);
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.rmSync(codexFixtureRoot, { recursive: true, force: true });
  }
});

test('system initialize reports selected OPL Gateway config as the model access source', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-initialize-opl-gateway-home-'));
  const codexFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-initialize-opl-gateway-bin-'));
  const codexPath = path.join(codexFixtureRoot, 'codex');
  const codexConfigFixture = createCodexConfigFixture({
    providerId: 'oplgateway',
    providerName: 'OPL Gateway',
    baseUrl: OPL_GATEWAY_BASE_URL,
    apiKey: 'opl-gateway-key',
  });
  fs.writeFileSync(codexPath, '#!/usr/bin/env bash\necho "codex-cli 0.125.0"\n', { mode: 0o755 });

  try {
    const output = runCli(['system', 'initialize'], {
      HOME: homeRoot,
      CODEX_HOME: codexConfigFixture.codexHome,
      OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      PATH: `${codexFixtureRoot}:/usr/bin:/bin`,
    }) as any;

    assert.equal(output.system_initialize.setup_flow.ready_to_launch, true);
    assert.equal(output.system_initialize.setup_flow.blocking_items.includes('codex_config'), false);
    assert.equal(output.system_initialize.core_engines.codex.api_key_present, true);
    assert.equal(output.system_initialize.core_engines.codex.opl_gateway_configured, true);
    assert.equal(output.system_initialize.core_engines.codex.model_access_ready, true);
    assert.equal(output.system_initialize.core_engines.codex.model_access_source, 'opl_gateway');
    assert.equal(JSON.stringify(output).includes('opl-gateway-key'), false);
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.rmSync(codexFixtureRoot, { recursive: true, force: true });
    fs.rmSync(codexConfigFixture.codexHome, { recursive: true, force: true });
  }
});

test('system initialize accepts App-managed runtime Codex when PATH has no Codex CLI', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-initialize-runtime-codex-home-'));
  const runtimeRoot = path.join(homeRoot, 'runtime');
  const runtimeBin = path.join(runtimeRoot, 'current', 'bin');
  const runtimeCodex = path.join(runtimeBin, 'codex');
  const codexConfigFixture = createCodexConfigFixture({
    model: 'gpt-5.5',
    reasoningEffort: 'xhigh',
    baseUrl: 'https://codex-provider.example.test/v1',
    apiKey: 'codex-provider-key',
  });

  fs.mkdirSync(runtimeBin, { recursive: true });
  fs.writeFileSync(runtimeCodex, '#!/usr/bin/env bash\necho "codex-cli 0.137.0"\n', { mode: 0o755 });

  try {
    const output = runCli(['system', 'initialize'], {
      HOME: homeRoot,
      CODEX_HOME: codexConfigFixture.codexHome,
      OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      OPL_RUNTIME_ROOT: runtimeRoot,
      OPL_DEVELOPER_MODE_GH_BINARY: path.join(homeRoot, 'missing-gh'),
      OPL_FAMILY_RUNTIME_PROVIDER: '',
      OPL_TEMPORAL_ADDRESS: '',
      TEMPORAL_ADDRESS: '',
      PATH: '/usr/bin:/bin',
    }) as any;

    assert.equal(output.system_initialize.setup_flow.ready_to_launch, true);
    assert.equal(output.system_initialize.setup_flow.blocking_items.includes('codex'), false);
    assert.equal(output.system_initialize.core_engines.codex.installed, true);
    assert.equal(output.system_initialize.core_engines.codex.binary_path, runtimeCodex);
    assert.equal(output.system_initialize.core_engines.codex.binary_source, 'runtime');
    assert.equal(output.system_initialize.core_engines.codex.health_status, 'ready');
    assert.equal(output.system_initialize.core_engines.codex.opl_gateway_configured, false);
    assert.equal(output.system_initialize.core_engines.codex.model_access_ready, true);
    assert.equal(output.system_initialize.core_engines.codex.model_access_source, 'custom_provider');
    assert.deepEqual(output.system_initialize.core_engines.codex.issues, []);
    assert.equal(
      output.system_initialize.core_engines.codex.runtime_substrate_updater.current_binary_path,
      runtimeCodex,
    );
    assert.equal(
      output.system_initialize.core_engines.codex.runtime_substrate_updater.current_binary_installed,
      true,
    );
    assert.equal(
      output.system_initialize.core_engines.codex.runtime_substrate_updater.current_version_status,
      'compatible',
    );
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.rmSync(codexConfigFixture.codexHome, { recursive: true, force: true });
  }
});

test('install command points WebUI users to the OPL Studio shell instead of a local Product API service', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-install-webui-note-home-'));

  try {
    const output = runCli(['install', '--skip-packages', '--skip-engines', '--headless', '--skip-native-helper-repair'], {
      HOME: homeRoot,
      OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      ...disableRemoteCompanionInstall(),
    }) as any;

    assert.doesNotMatch(output.install.notes.join('\n'), /serve-web|8787|Product API service/);
    assert.match(output.install.notes.join('\n'), /optional desktop App only with --with-app/);
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('install command reuses only the default Codex engine and reports Temporal provider setup', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-install-engines-home-'));
  const codexFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-install-codex-'));
  const codexConfigFixture = createCodexConfigFixture();
  const codexPath = path.join(codexFixtureRoot, 'codex');

  fs.writeFileSync(codexPath, '#!/usr/bin/env bash\necho "codex-cli 0.125.0"\n', { mode: 0o755 });

  try {
    const output = runCli(
      ['install', '--skip-packages', '--headless', '--skip-native-helper-repair'],
      {
        HOME: homeRoot,
        CODEX_HOME: codexConfigFixture.codexHome,
        OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
        OPL_FAMILY_RUNTIME_PROVIDER: '',
        OPL_TEMPORAL_ADDRESS: '',
        TEMPORAL_ADDRESS: '',
        PATH: `${codexFixtureRoot}:/usr/bin:/bin`,
        ...disableRemoteCompanionInstall(),
      },
    ) as any;

    assert.deepEqual(output.install.selected_engines, ['codex']);
    assert.deepEqual(
      output.install.engine_actions.map((entry: any) => [entry.engine_id, entry.status, entry.strategy]),
      [
        ['codex', 'skipped_installed', 'already_installed'],
      ],
    );
    assert.deepEqual(
      output.install.runtime_manager_action.executed_actions.map((entry: any) => entry.action_id),
      ['configure_temporal_provider'],
    );
  } finally {
    fs.rmSync(codexConfigFixture.codexHome, { recursive: true, force: true });
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.rmSync(codexFixtureRoot, { recursive: true, force: true });
  }
});
