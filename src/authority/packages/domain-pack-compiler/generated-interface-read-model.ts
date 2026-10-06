import {
  buildFamilyActionCatalogParity,
  projectFamilyAction,
  projectFamilyActionCatalog,
} from '../../../kernel/family-action-catalog-projection.ts';
import type {
  FamilyActionCatalog,
  FamilyActionCatalogAction,
} from '../../../kernel/family-action-catalog-contract.ts';
import { buildGeneratedDirectParityProof } from './generated-interface-parity.ts';
import type { FamilyStageControlPlane } from '../../stages/index.ts';
import { buildToolAffordanceBoundaryRoute } from './stage-route-tool-affordance.ts';
import {
  buildActiveCallerTargetProof,
  handoffSurfaceFor,
} from './generated-interface-active-caller-proof.ts';
import { buildGeneratedSurfaceConsumptionBundle } from './generated-surface-consumption.ts';
import {
  buildActiveCallerCutoverProof,
  buildActiveLegacyCallerDeletionGateReadout,
  buildGeneratedWrapperBundle,
} from './generated-interface-parts/proofs.ts';
import type { GeneratedInterfaceFormat } from './generated-interface-parts/format-selection.ts';
import { isRecord } from '../../../kernel/contract-validation.ts';
import { optionalString } from '../../../kernel/json-file.ts';

export {
  selectGeneratedInterfaceBundleFormat,
  type GeneratedInterfaceFormat,
} from './generated-interface-parts/format-selection.ts';

type JsonRecord = Record<string, unknown>;

type StandardAgentContractResolutionReadback = {
  surface_kind: 'opl_standard_agent_contract_checkout_resolution';
  status: 'resolved' | 'blocked' | 'not_applicable';
  launch_allowed: boolean;
  reason: string | null;
  source_status: string | null;
};

type GeneratedInterfaceReadModelOptions = {
  standardAgentContractResolution?: StandardAgentContractResolutionReadback;
};

const BLOCKED_STANDARD_AGENT_CONTRACT_RESOLUTION = 'blocked_by_standard_agent_contract_resolution';

export const GENERATED_INTERFACE_SOURCE_REFS = [
  'family_action_catalog',
  'family_stage_control_plane',
  'domain_memory_descriptor',
  'runtime_surfaces',
  'functional_privatization_audit',
  'generated_surface_handoff',
  'product_entry_manifest_descriptor',
  'domain_handler_descriptor',
] as const;

export const GENERATED_SURFACES = [
  {
    surface_id: 'cli',
    required_descriptor_surfaces: ['family_action_catalog'],
  },
  {
    surface_id: 'mcp',
    required_descriptor_surfaces: ['family_action_catalog'],
  },
  {
    surface_id: 'skill',
    required_descriptor_surfaces: ['family_action_catalog'],
  },
  {
    surface_id: 'product_entry_manifest',
    required_descriptor_surfaces: ['entry', 'family_action_catalog'],
  },
  {
    surface_id: 'domain_handler',
    required_descriptor_surfaces: ['family_action_catalog', 'functional_privatization_audit'],
  },
  {
    surface_id: 'status_read_model',
    required_descriptor_surfaces: ['entry', 'runtime_surfaces', 'domain_memory_descriptor'],
  },
  {
    surface_id: 'workbench_drilldown',
    required_descriptor_surfaces: ['domain_memory_descriptor', 'runtime_surfaces', 'family_action_catalog'],
  },
] as const;

const GENERATED_DEFAULT_ENTRY_SURFACE_IDS = [
  'cli',
  'mcp',
  'openai_tool',
  'ai_sdk',
  'skill_plugin',
  'app_action',
  'status_read_model',
  'workbench',
] as const;

const SUPPORTED_DERIVED_SURFACES = [
  {
    surface_id: 'cli',
    descriptor_block: 'cli',
    source_catalogs: ['family_action_catalog'],
  },
  {
    surface_id: 'mcp',
    descriptor_block: 'mcp',
    source_catalogs: ['family_action_catalog'],
  },
  {
    surface_id: 'openai_tool',
    descriptor_block: 'openai_tool',
    source_catalogs: ['family_action_catalog'],
  },
  {
    surface_id: 'ai_sdk',
    descriptor_block: 'ai_sdk',
    source_catalogs: ['family_action_catalog'],
  },
  {
    surface_id: 'skill_plugin',
    descriptor_block: 'skill',
    source_catalogs: ['family_action_catalog'],
  },
  {
    surface_id: 'app_action',
    descriptor_block: 'product_entry',
    source_catalogs: ['family_action_catalog'],
  },
  {
    surface_id: 'status_read_model',
    descriptor_block: 'product_status',
    source_catalogs: ['family_action_catalog', 'runtime_surfaces'],
  },
  {
    surface_id: 'workbench',
    descriptor_block: 'workbench',
    source_catalogs: ['family_stage_control_plane', 'domain_memory_descriptor', 'runtime_surfaces'],
  },
] as const;

function buildDefaultEntryPolicy() {
  return {
    surface_kind: 'opl_generated_surface_default_entry_policy',
    version: 'opl-generated-surface-default-entry-policy.v1',
    owner: 'one-person-lab',
    status: 'generated_surfaces_are_default_entry_baseline',
    source_catalogs: ['family_action_catalog', 'family_stage_control_plane'],
    domain_repo_wrapper_policy: 'handler_target_refs_only_adapter_or_tombstone_candidate',
    domain_repo_can_own_default_entry: false,
    default_entry_surface_ids: [...GENERATED_DEFAULT_ENTRY_SURFACE_IDS],
  };
}
function buildSupportedDerivedSurfaces() {
  return SUPPORTED_DERIVED_SURFACES.map((surface) => ({
    ...surface,
    owner: 'one-person-lab',
    default_entry: true,
    domain_repo_can_own_generated_surface: false,
    source_catalogs: [...surface.source_catalogs],
    domain_repo_role: 'handler_target_refs_only_adapter_or_tombstone_candidate',
  }));
}

function buildActionStageRoutes(catalog: FamilyActionCatalog | null) {
  return catalog?.actions.flatMap((action) => (
    action.execution_binding.kind === 'stage_binding'
    && action.stage_route
    ? [{ action_id: action.action_id, ...action.stage_route }]
    : []
  )) ?? [];
}

function buildSourceOfWorkLineage(catalog: FamilyActionCatalog | null, stageControlPlane: FamilyStageControlPlane | null) {
  return {
    surface_kind: 'opl_generated_surface_source_of_work_lineage',
    version: 'opl-generated-surface-source-of-work-lineage.v1',
    owner: 'one-person-lab',
    status: catalog ? 'ready_from_family_action_catalog' : 'blocked_missing_family_action_catalog',
    source_catalogs: ['family_action_catalog', 'family_stage_control_plane'],
    action_catalog_ref: catalog ? `family_action_catalog:${catalog.catalog_id}` : null,
    stage_catalog_ref: stageControlPlane ? `family_stage_control_plane:${stageControlPlane.plane_id}` : null,
    action_ids: catalog?.actions.map((action) => action.action_id) ?? [],
    derived_surface_ids: [...GENERATED_DEFAULT_ENTRY_SURFACE_IDS],
    derived_surface_policy: 'derive_cli_mcp_openai_ai_sdk_skill_app_status_workbench_from_single_catalog',
    domain_repo_wrapper_policy: 'handler_target_refs_only_adapter_or_tombstone_candidate',
    authority_boundary: {
      lineage_can_write_domain_truth: false,
      lineage_can_replace_domain_handler: false,
      lineage_can_authorize_quality_or_export: false,
      lineage_can_claim_domain_ready: false,
      lineage_can_claim_production_ready: false,
    },
  };
}

function buildGeneratedDefaultEntryNoResurrectionGate(
  catalog: FamilyActionCatalog | null,
  stageControlPlane: FamilyStageControlPlane | null,
) {
  const sourceActionIds = catalog?.actions
    .map((action) => action.source_of_work?.source_action_id ?? action.action_id)
    ?? [];
  const actionCatalogRefs = unique(
    catalog?.actions.map((action) =>
      action.source_of_work?.source_catalog_ref ?? `family_action_catalog:${catalog.catalog_id}`
    ) ?? [],
  );
  const stageCatalogRefs = unique(
    catalog?.actions
      .map((action) => action.source_of_work?.stage_catalog_ref ?? null)
      .filter((entry): entry is string => Boolean(entry)) ?? [],
  );
  const stageCatalogRef =
    stageCatalogRefs[0]
    ?? (stageControlPlane ? `family_stage_control_plane:${stageControlPlane.plane_id}` : null);
  const lineageReady = Boolean(catalog && sourceActionIds.length > 0);

  return {
    surface_kind: 'opl_generated_default_entry_no_resurrection_gate',
    version: 'opl-generated-default-entry-no-resurrection-gate.v1',
    owner: 'one-person-lab',
    release_gate: true,
    gate_status: lineageReady ? 'pass' : 'blocked_missing_source_of_work_lineage',
    default_entry_policy_ref: 'generated_agent_interfaces.default_entry_policy',
    source_of_work_lineage_ref: 'generated_agent_interfaces.source_of_work_lineage',
    required_default_entry_surface_ids: [...GENERATED_DEFAULT_ENTRY_SURFACE_IDS],
    required_lineage_policy: 'each_default_entry_surface_carries_action_catalog_source_of_work_lineage; stage_catalog_ref_is_optional_projection_context',
    domain_repo_wrapper_policy: 'handler_target_refs_only_adapter_or_tombstone_candidate',
    domain_repo_can_own_default_entry: false,
    descriptor_pass_can_claim_domain_ready: false,
    handwritten_default_tool_surface_allowed: false,
    domain_local_wrapper_can_be_default_entry: false,
    blocked_resurrection_surface_classes: [
      'domain_local_wrapper',
      'domain_local_frontdoor',
      'handwritten_default_tool_surface',
      'repo_local_status_shell',
      'repo_local_workbench_shell',
    ],
    source_catalogs: ['family_action_catalog', 'family_stage_control_plane'],
    action_catalog_refs: actionCatalogRefs,
    stage_catalog_ref: stageCatalogRef,
    default_entry_surface_lineage: SUPPORTED_DERIVED_SURFACES.map((surface) => ({
      surface_id: surface.surface_id,
      descriptor_block: surface.descriptor_block,
      owner: 'one-person-lab',
      default_entry: true,
      domain_repo_can_own_default_entry: false,
      domain_repo_can_own_generated_surface: false,
      descriptor_pass_can_claim_domain_ready: false,
      source_catalogs: [...surface.source_catalogs],
      source_of_work_lineage: {
        source_catalog: 'family_action_catalog',
        source_catalog_refs: actionCatalogRefs,
        source_action_ids: sourceActionIds,
        stage_catalog_ref: stageCatalogRef,
        derived_surface_policy: 'derive_cli_mcp_openai_ai_sdk_skill_app_status_workbench_from_single_catalog',
        domain_repo_wrapper_policy: 'handler_target_refs_only_adapter_or_tombstone_candidate',
      },
    })),
    authority_boundary: {
      gate_can_claim_domain_ready: false,
      gate_can_claim_production_ready: false,
      gate_can_write_domain_truth: false,
      gate_can_authorize_quality_or_export: false,
    },
  };
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function rawDescriptorSurface<T>(descriptor: JsonRecord, key: string): T | null {
  const surface = isRecord(descriptor[key]) ? descriptor[key] as JsonRecord : null;
  if (!surface) {
    return null;
  }
  const raw = surface.raw_descriptor;
  return isRecord(raw) ? raw as T : null;
}

function projectStandardAgentContractBlock<T extends JsonRecord>(
  block: T,
  blockedReason: string | null,
) {
  return blockedReason
    ? {
        ...block,
        status: BLOCKED_STANDARD_AGENT_CONTRACT_RESOLUTION,
        blocked_reason: blockedReason,
      }
    : block;
}

function projectGeneratedDirectParitySourceBlock<T extends JsonRecord>(
  parity: T,
  blockedReason: string | null,
) {
  if (!blockedReason) {
    return parity;
  }
  const issues = Array.isArray(parity.issues)
    ? parity.issues.filter((issue) => issue !== 'missing family_action_catalog')
    : [];
  return {
    ...parity,
    status: BLOCKED_STANDARD_AGENT_CONTRACT_RESOLUTION,
    blocked_reason: blockedReason,
    issues: [...issues, `standard agent contract source blocked: ${blockedReason}`],
  };
}

function descriptorRecord(descriptor: JsonRecord, key: string) {
  return isRecord(descriptor[key]) ? descriptor[key] as JsonRecord : null;
}

function hostedWorkspacePath(descriptor: JsonRecord) {
  const sourceContractConsumption = descriptorRecord(descriptor, 'source_contract_consumption');
  const workspacePath = optionalString(descriptor.repo_dir)
    ?? optionalString(descriptor.workspace_path)
    ?? optionalString(sourceContractConsumption?.workspace_path);
  if (!workspacePath) {
    throw new Error('Generated family action interfaces require an absolute workspace path.');
  }
  return workspacePath;
}

function buildStageRoutes(stageControlPlane: FamilyStageControlPlane | null) {
  return stageControlPlane?.stages.map((stage) => {
    const toolAffordanceBoundary = buildToolAffordanceBoundaryRoute(stage);
    const includeStagePackRefs =
      stage.stage_pack_conformance_version === 'standard-stage-pack.v2'
      || Boolean(toolAffordanceBoundary);
    return {
      stage_id: stage.stage_id,
      allowed_action_refs: stage.allowed_action_refs,
      authority_owner: stage.owner,
      ...(includeStagePackRefs && stage.prompt_refs.length > 0 ? { prompt_refs: stage.prompt_refs } : {}),
      ...(includeStagePackRefs && stage.skills.length > 0 ? { skills: stage.skills } : {}),
      ...(includeStagePackRefs && stage.tool_refs && stage.tool_refs.length > 0 ? { tool_refs: stage.tool_refs } : {}),
      ...(includeStagePackRefs && stage.knowledge_refs.length > 0 ? { knowledge_refs: stage.knowledge_refs } : {}),
      ...(includeStagePackRefs && stage.evaluation.length > 0 ? { evaluation: stage.evaluation } : {}),
      ...(toolAffordanceBoundary ? { tool_affordance_boundary: toolAffordanceBoundary } : {}),
      ...(stage.stage_contract?.progress_delta_policy ? {
        progress_delta_policy: {
          surface_kind: typeof stage.stage_contract.progress_delta_policy.surface_kind === 'string'
            ? stage.stage_contract.progress_delta_policy.surface_kind
            : 'opl_stage_progress_delta_policy',
          required_fields: Array.isArray(stage.stage_contract.progress_delta_policy.required_fields)
            ? stage.stage_contract.progress_delta_policy.required_fields.filter((field): field is string =>
              typeof field === 'string'
            )
            : [],
          platform_only_is_not_deliverable_progress:
            stage.stage_contract.progress_delta_policy.platform_only_is_not_deliverable_progress === true,
        },
      } : {}),
      ...(stage.stage_contract?.typed_blocker_lineage_policy ? {
        typed_blocker_lineage_policy: {
          surface_kind: typeof stage.stage_contract.typed_blocker_lineage_policy.surface_kind === 'string'
            ? stage.stage_contract.typed_blocker_lineage_policy.surface_kind
            : 'family-stall-lineage.v1',
          repeat_budget: isRecord(stage.stage_contract.typed_blocker_lineage_policy.repeat_budget)
            ? stage.stage_contract.typed_blocker_lineage_policy.repeat_budget
            : null,
        },
      } : {}),
    };
  }) ?? [];
}

function buildProductEntryDescriptors(catalog: FamilyActionCatalog, workspacePath: string) {
  return catalog.actions
    .filter((action) => action.supported_surfaces.product_entry !== null)
    .map((action) => projectFamilyAction(action, catalog.target_domain_id, workspacePath).product_entry);
}

function firstActionForStageControlPlane(
  catalog: FamilyActionCatalog | null,
  stageControlPlane: FamilyStageControlPlane | null,
): FamilyActionCatalogAction | null {
  if (!catalog) {
    return null;
  }
  const allowedActionIds = new Set(
    stageControlPlane?.stages.flatMap((stage) => stage.allowed_action_refs) ?? [],
  );
  return catalog.actions.find((action) => allowedActionIds.has(action.action_id))
    ?? catalog.actions[0]
    ?? null;
}

function defaultSourceOfWork(
  catalog: FamilyActionCatalog | null,
  stageControlPlane: FamilyStageControlPlane | null,
  workspacePath: string,
) {
  const action = firstActionForStageControlPlane(catalog, stageControlPlane);
  return action
    ? projectFamilyAction(action, catalog!.target_domain_id, workspacePath).product_entry.source_of_work
    : null;
}

function buildProductStatusDescriptors(catalog: FamilyActionCatalog | null, workspacePath: string) {
  if (!catalog) {
    return [];
  }
  const statusSurfaceKinds = new Set([
    'product_entry_status',
    'workspace_cockpit',
    'study_progress',
    'mainline_status',
    'mainline_phase',
  ]);
  return catalog.actions
    .filter((action) => {
      if (action.supported_surfaces.product_entry === null) {
        return false;
      }
      const surfaceKind = action.supported_surfaces.product_entry?.surface_kind
        ?? 'opl_agent_action_product_entry';
      return statusSurfaceKinds.has(surfaceKind) || action.effect === 'read_only';
    })
    .map((action) => {
      const projection = projectFamilyAction(action, catalog.target_domain_id, workspacePath).product_entry;
      return {
        action_id: action.action_id,
        command: projection.command,
        surface_kind: projection.surface_kind,
        summary: action.summary,
        effect: action.effect,
        source_descriptor: 'family_action_catalog.execution_binding',
        execution_binding: action.execution_binding,
        source_of_work: projection.source_of_work,
      };
    });
}

function buildDomainHandlerDescriptors(catalog: FamilyActionCatalog | null, workspacePath: string) {
  if (!catalog) {
    return [];
  }
  return catalog.actions.flatMap((action) => {
      if (action.execution_binding.kind !== 'handler_ref') {
        return [];
      }
      const projection = projectFamilyAction(action, catalog.target_domain_id, workspacePath).product_entry;
      return [{
        action_id: action.action_id,
        command: projection.command,
        surface_kind: projection.surface_kind,
        summary: action.summary,
        effect: action.effect,
        authority_boundary: action.authority_boundary ?? null,
        required_fields: action.required_fields,
        optional_fields: action.optional_fields,
        workspace_locator_fields: action.workspace_locator_fields,
        execution_binding: action.execution_binding,
        handler_ref: action.execution_binding.handler_ref,
        source_of_work: projection.source_of_work,
      }];
    });
}

function buildProductSessionDescriptor(
  catalog: FamilyActionCatalog | null,
  stageControlPlane: FamilyStageControlPlane | null,
) {
  return {
    surface_kind: 'opl_generated_product_session_descriptor',
    owner: 'one-person-lab',
    status: catalog
      ? (stageControlPlane ? 'ready_from_stage_control_plane' : 'ready_from_action_catalog_with_stage_projection_debt')
      : 'blocked_missing_family_action_catalog',
    descriptor_source_surfaces: ['family_action_catalog', 'session_continuity_or_stage_routes'],
    session_routes: buildStageRoutes(stageControlPlane),
    authority_boundary: {
      product_session_can_write_domain_truth: false,
      product_session_can_authorize_quality_or_export: false,
      product_session_routes_to_domain_owner_receipts: true,
    },
  };
}

function buildProductSessionDescriptorFromDescriptor(
  descriptor: JsonRecord,
  catalog: FamilyActionCatalog | null,
  stageControlPlane: FamilyStageControlPlane | null,
) {
  const sessionContinuity = descriptorRecord(descriptor, 'session_continuity_contract');
  const sessionSurface = sessionContinuity ? descriptorRecord(sessionContinuity, 'entry_surface') : null;
  const restoreSurface = sessionContinuity ? descriptorRecord(sessionContinuity, 'restore_surface') : null;
  return {
    ...buildProductSessionDescriptor(
      catalog,
      stageControlPlane,
    ),
    status:
      sessionContinuity || stageControlPlane
        ? 'ready_from_session_continuity_or_stage_control_plane'
        : descriptorRecord(descriptor, 'family_action_catalog')
          ? 'ready_from_action_catalog_with_stage_projection_debt'
          : 'blocked_missing_session_continuity_and_family_action_catalog',
    descriptor_source_surfaces: ['session_continuity', 'family_action_catalog', 'family_stage_control_plane'],
    session_continuity_status: optionalString(sessionContinuity?.status),
    entry_surface: sessionSurface,
    restore_surface: restoreSurface,
  };
}

function buildDomainHandlerDescriptorBlock(
  catalog: FamilyActionCatalog | null,
  descriptor: JsonRecord,
  workspacePath: string,
) {
  const descriptors = buildDomainHandlerDescriptors(catalog, workspacePath);
  const handoff = handoffSurfaceFor(descriptor, 'domain_handler');
  return {
    surface_kind: 'opl_generated_domain_handler_descriptor',
    owner: 'one-person-lab',
    status:
      descriptors.length > 0 || handoff
        ? 'ready'
        : catalog
          ? 'ready_no_domain_handler_actions_declared'
          : 'blocked_missing_family_action_catalog',
    descriptor_source_surfaces: ['family_action_catalog', 'generated_surface_handoff'],
    descriptors,
    handoff_surface: handoff,
    authority_boundary: {
      domain_handler_descriptor_can_write_domain_truth: false,
      domain_handler_descriptor_can_mutate_artifacts: false,
      domain_handler_dispatch_returns_domain_owner_receipt_or_typed_blocker: true,
    },
  };
}

function buildWorkbenchDescriptorBlock(
  catalog: FamilyActionCatalog | null,
  stageControlPlane: FamilyStageControlPlane | null,
  descriptor: JsonRecord,
  workspacePath: string,
) {
  return {
    surface_kind: 'opl_hosted_workbench_descriptor',
    owner: 'one-person-lab',
    status: catalog
      ? (stageControlPlane ? 'ready_from_stage_control_plane' : 'ready_from_action_catalog_with_stage_projection_debt')
      : 'blocked_missing_family_action_catalog',
    descriptor_source_surfaces: ['family_action_catalog', 'family_stage_control_plane', 'domain_memory_descriptor', 'runtime_surfaces'],
    source_of_work_lineage: buildSourceOfWorkLineage(catalog, stageControlPlane),
    default_source_of_work: defaultSourceOfWork(catalog, stageControlPlane, workspacePath),
    source_of_work_consumption_policy:
      'workbench_consumes_generated_surface_lineage_and_stage_routes_without_claiming_domain_ready',
    handoff_surface: handoffSurfaceFor(descriptor, 'workbench_drilldown'),
    stage_routes: buildStageRoutes(stageControlPlane),
    authority_boundary: {
      workbench_can_write_domain_truth: false,
      workbench_can_write_memory_body: false,
      workbench_can_authorize_quality_or_export: false,
      workbench_reads_refs_only: true,
    },
  };
}

function formatDescriptorBlock(
  catalog: FamilyActionCatalog | null,
  format: GeneratedInterfaceFormat,
  stageControlPlane: FamilyStageControlPlane | null,
  workspacePath: string,
) {
  if (!catalog) {
    return {
      format,
      owner: 'one-person-lab',
      status: 'blocked_missing_family_action_catalog',
      descriptors: [],
    };
  }
  if (format === 'product-entry') {
    return {
      format,
      owner: 'one-person-lab',
      status: 'ready',
      descriptors: buildProductEntryDescriptors(catalog, workspacePath),
      family_stage_control_plane: stageControlPlane,
    };
  }
  return {
    format,
    owner: 'one-person-lab',
    status: 'ready',
    descriptors: projectFamilyActionCatalog(catalog, format, workspacePath),
  };
}

export function buildGeneratedInterfaceBundle(
  descriptor: JsonRecord,
  compilerStatus: string,
  selectedFormat: GeneratedInterfaceFormat | 'all' = 'all',
  options: GeneratedInterfaceReadModelOptions = {},
) {
  const rawCatalog = rawDescriptorSurface<FamilyActionCatalog>(descriptor, 'family_action_catalog');
  const standardAgentContractResolution = options.standardAgentContractResolution ?? null;
  const sourceBlockedReason = standardAgentContractResolution?.status === 'blocked'
    ? standardAgentContractResolution.reason ?? 'standard_agent_contract_resolution_blocked'
    : null;
  const catalog = sourceBlockedReason ? null : rawCatalog;
  const rawStageControlPlane = rawDescriptorSurface<FamilyStageControlPlane>(
    descriptor,
    'family_stage_control_plane',
  );
  const stageControlPlane = catalog ? rawStageControlPlane : null;
  const workspacePath = catalog ? hostedWorkspacePath(descriptor) : '';
  const formats: GeneratedInterfaceFormat[] = ['cli', 'mcp', 'skill', 'product-entry', 'openai', 'ai-sdk'];
  const include = (format: GeneratedInterfaceFormat) => selectedFormat === 'all' || selectedFormat === format;
  const block = (format: GeneratedInterfaceFormat) => projectStandardAgentContractBlock(
    formatDescriptorBlock(
      catalog,
      format,
      stageControlPlane,
      workspacePath,
    ),
    sourceBlockedReason,
  );
  const allBlocks = Object.fromEntries(
    formats.map((format) => [
        format === 'product-entry'
          ? 'product_entry'
          : format === 'openai'
            ? 'openai_tool'
            : format === 'ai-sdk'
              ? 'ai_sdk'
              : format,
        block(format),
      ])
  );
  const selectedBlocks = Object.fromEntries(
    Object.entries(allBlocks).filter(([, value]) => include(value.format as GeneratedInterfaceFormat)),
  );
  const allGeneratedBlockKeys = Object.keys(allBlocks);
  const allGeneratedBlocksReady = allGeneratedBlockKeys.every((key) => {
    const value = allBlocks[key];
    return isRecord(value) && optionalString(value.status) === 'ready';
  });
  const selectedGeneratedBlockKeys = Object.keys(selectedBlocks);
  const selectedGeneratedBlocksReady = selectedGeneratedBlockKeys.every((key) => {
    const value = selectedBlocks[key];
    return isRecord(value) && optionalString(value.status) === 'ready';
  });
  const activeCallerTargetProof = buildActiveCallerTargetProof(descriptor, GENERATED_SURFACES);
  const sourceOfWorkLineage = projectStandardAgentContractBlock(
    buildSourceOfWorkLineage(catalog, stageControlPlane),
    sourceBlockedReason,
  );
  const productStatus = projectStandardAgentContractBlock({
    surface_kind: 'opl_generated_product_status_descriptor',
    owner: 'one-person-lab',
    status: catalog ? 'ready_from_family_action_catalog' : 'blocked_missing_family_action_catalog',
    descriptor_source_surfaces: ['family_action_catalog', 'runtime_surfaces'],
    source_of_work_lineage: sourceOfWorkLineage,
    default_source_of_work: defaultSourceOfWork(catalog, stageControlPlane, workspacePath),
    source_of_work_consumption_policy:
      'status_read_model_consumes_generated_surface_lineage_without_claiming_domain_ready',
    descriptors: buildProductStatusDescriptors(catalog, workspacePath),
    authority_boundary: {
      product_status_can_write_domain_truth: false,
      product_status_can_authorize_quality_or_export: false,
      product_status_reads_refs_only: true,
    },
  }, sourceBlockedReason);
  const productSession = projectStandardAgentContractBlock(
    buildProductSessionDescriptorFromDescriptor(descriptor, catalog, stageControlPlane),
    sourceBlockedReason,
  );
  const domainHandler = projectStandardAgentContractBlock(
    buildDomainHandlerDescriptorBlock(catalog, descriptor, workspacePath),
    sourceBlockedReason,
  );
  const workbench = {
    ...projectStandardAgentContractBlock(
      buildWorkbenchDescriptorBlock(catalog, stageControlPlane, descriptor, workspacePath),
      sourceBlockedReason,
    ),
    source_of_work_lineage: sourceOfWorkLineage,
  };
  const generatedDefaultEntryNoResurrectionGate = buildGeneratedDefaultEntryNoResurrectionGate(
    catalog,
    stageControlPlane,
  );
  const wrapperBlocks = {
    ...allBlocks,
    product_status: productStatus,
    product_session: productSession,
    domain_handler: domainHandler,
    workbench,
  };
  const generatedDirectParity = projectGeneratedDirectParitySourceBlock(
    buildGeneratedDirectParityProof(
      catalog,
      allBlocks,
      activeCallerTargetProof,
      workspacePath,
    ),
    sourceBlockedReason,
  );
  const activeCallerCutoverProof = buildActiveCallerCutoverProof(
    descriptor,
    compilerStatus,
    allGeneratedBlocksReady,
    allGeneratedBlockKeys,
    activeCallerTargetProof,
  );
  const generatedWrapperBundle = buildGeneratedWrapperBundle(
    wrapperBlocks,
    allGeneratedBlocksReady,
    activeCallerTargetProof,
  );
  const generatedSurfaceConsumptionBundle = buildGeneratedSurfaceConsumptionBundle({
    supportedDerivedSurfaces: SUPPORTED_DERIVED_SURFACES,
    blocks: wrapperBlocks,
    compilerStatus,
    generatedBlocksReady: selectedGeneratedBlocksReady,
    generatedBlockKeys: selectedGeneratedBlockKeys,
    selectedFormat,
    sourceOfWorkLineage,
    activeCallerCutoverProof,
    generatedWrapperBundle,
  });

  return {
    surface_kind: 'opl_generated_agent_interface_bundle',
    version: 'opl-generated-agent-interface-bundle.v1',
    owner: 'one-person-lab',
    generated_surface_owner: 'one-person-lab',
    domain_repo_can_own_generated_surface: false,
    status:
      compilerStatus === 'ready'
      && selectedGeneratedBlocksReady
      && generatedWrapperBundle.status === 'ready'
      && generatedDirectParity.status === 'aligned'
        ? 'ready'
        : 'blocked',
    blocker_reasons: sourceBlockedReason
      ? [sourceBlockedReason]
      : catalog
        ? []
        : ['blocked_missing_family_action_catalog'],
    standard_agent_contract_resolution: standardAgentContractResolution,
    selected_format: selectedFormat,
    project_id: optionalString(descriptor.project_id),
    target_domain_id: optionalString(descriptor.target_domain_id),
    agent_id: optionalString(descriptor.agent_id),
    generated_from: GENERATED_INTERFACE_SOURCE_REFS,
    default_entry_policy: buildDefaultEntryPolicy(),
    supported_derived_surfaces: buildSupportedDerivedSurfaces(),
    source_of_work_lineage: sourceOfWorkLineage,
    generated_default_entry_no_resurrection_gate: generatedDefaultEntryNoResurrectionGate,
    ...selectedBlocks,
    active_caller_cutover_proof: activeCallerCutoverProof,
    generated_wrapper_bundle: generatedWrapperBundle,
    generated_surface_consumption_bundle: generatedSurfaceConsumptionBundle,
    product_status: productStatus,
    product_session: productSession,
    domain_handler: domainHandler,
    workbench,
    active_caller_target_proof: activeCallerTargetProof,
    active_legacy_caller_deletion_gate_readout: buildActiveLegacyCallerDeletionGateReadout(
      activeCallerTargetProof,
      generatedWrapperBundle,
    ),
    stage_routes: include('product-entry') || selectedFormat === 'all'
      ? buildStageRoutes(stageControlPlane)
      : [],
    action_stage_routes: buildActionStageRoutes(catalog),
    parity: catalog ? buildFamilyActionCatalogParity(catalog, workspacePath) : null,
    generated_direct_parity: generatedDirectParity,
    authority_boundary: {
      generated_interface_can_write_domain_truth: false,
      generated_interface_can_write_memory_body: false,
      generated_interface_can_authorize_quality_or_export: false,
      generated_interface_can_mutate_artifacts: false,
      generated_interface_routes_to_minimal_authority_functions_by_receipt_contract: true,
      provider_completion_is_domain_ready: false,
    },
    source_contract_consumption: descriptorRecord(descriptor, 'source_contract_consumption'),
  };
}
