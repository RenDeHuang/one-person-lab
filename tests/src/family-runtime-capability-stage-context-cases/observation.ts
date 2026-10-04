import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCapabilityRegistryReadout,
  type CapabilityRegistryCatalog,
  type CurrentOwnerDeltaCapabilityBinding,
} from '../../../src/adapters/integration/capability-registry-resolver.ts';
import {
  buildCapabilityRegistryStageContextReceipt,
  capabilityRegistryStageContextInputFromPayload,
} from '../../../src/adapters/execution/family-runtime-stage-context-observation.ts';

const emptyRegistry: CapabilityRegistryCatalog = {
  registry_id: 'opl.capability_registry.runtime-gate-test',
  owner_modules: ['atlas', 'pack', 'stagecraft'],
  capabilities: [],
};

const registryWithRequiredRoute: CapabilityRegistryCatalog = {
  ...emptyRegistry,
  capabilities: [{
    capability_ref: 'capability:review-source-route',
    capability_id: 'review_source_route',
    owner: 'one-person-lab',
    source_family: 'opl_native',
    surface_ref: 'opl://capabilities/review-source-route',
    lifecycle: 'available',
  }],
};

const routeRequiredDelta: CurrentOwnerDeltaCapabilityBinding = {
  surface_kind: 'opl_current_owner_delta',
  schema_version: 'current-owner-delta.v1',
  default_planning_root: 'current_owner_delta',
  delta_id: 'current-owner-delta:mas:review',
  domain: 'mas',
  task_or_study_ref: 'task:capability-gate',
  stage_ref: 'review',
  current_owner: 'med-autoscience',
  required_capability_refs: [{
    capability_ref: 'capability:review-source-route',
    binding_kind: 'route_required',
    hard_boundary: 'owner_route_identity',
    required_by_delta_ref: 'current-owner-delta:mas:review',
  }],
};

function missingRouteReadout(delta = routeRequiredDelta) {
  return buildCapabilityRegistryReadout({
    registry: emptyRegistry,
    currentOwnerDelta: delta,
    requestedCapabilities: [{
      capabilityRef: 'capability:review-source-route',
      taskOrStudyRef: 'task:capability-gate',
      stageRef: 'review',
      bindingKind: 'route_required',
    }],
  });
}

function resolvedRouteReadout() {
  return buildCapabilityRegistryReadout({
    registry: registryWithRequiredRoute,
    currentOwnerDelta: routeRequiredDelta,
    requestedCapabilities: [{
      capabilityRef: 'capability:review-source-route',
      taskOrStudyRef: 'task:capability-gate',
      stageRef: 'review',
      bindingKind: 'route_required',
    }],
  });
}

export function registerObservationTests() {
test('capability launch gate is not applicable during planning without current delta or typed readout', () => {
  const receipt = buildCapabilityRegistryStageContextReceipt({
    lifecyclePhase: 'planning',
    domainId: 'medautoscience',
    stageId: 'review',
    taskId: 'task:capability-gate',
  });

  assert.equal(receipt.status, 'not_applicable');
  assert.equal(receipt.advisory_reason, null);
  assert.equal(receipt.authority_boundary.can_write_domain_truth, false);
  assert.equal(receipt.authority_boundary.can_sign_owner_receipt, false);
  assert.equal(receipt.authority_boundary.can_create_domain_typed_blocker, false);
});

test('capability launch gate keeps missing optional capabilities fail-open during execution', () => {
  const optionalDelta: CurrentOwnerDeltaCapabilityBinding = {
    ...routeRequiredDelta,
    required_capability_refs: [{
      capability_ref: 'capability:optional-review-aid',
      binding_kind: 'optional',
    }],
  };
  const readout = buildCapabilityRegistryReadout({
    registry: emptyRegistry,
    currentOwnerDelta: optionalDelta,
    requestedCapabilities: [{
      capabilityRef: 'capability:optional-review-aid',
      taskOrStudyRef: 'task:capability-gate',
      stageRef: 'review',
      bindingKind: 'optional',
    }],
  });
  const receipt = buildCapabilityRegistryStageContextReceipt({
    lifecyclePhase: 'execution',
    domainId: 'medautoscience',
    stageId: 'review',
    taskId: 'task:capability-gate',
    currentOwnerDelta: optionalDelta,
    capabilityRegistryResolutionReceipts: readout.resolutions,
    capabilityRegistryResolutionReceiptRefs: ['opl://capability-resolutions/optional-review-aid'],
  });

  assert.equal(receipt.status, 'observed');
  assert.equal(receipt.advisory_reason, null);
  assert.equal(receipt.typed_input_status.capability_registry_readout, 'missing');
  assert.equal(receipt.typed_input_status.capability_registry_resolution_receipt_count, 1);
  assert.deepEqual(
    receipt.input_refs.capability_registry_resolution_receipt_refs,
    ['opl://capability-resolutions/optional-review-aid'],
  );
  assert.deepEqual(receipt.optional_fail_open_capability_refs, ['capability:optional-review-aid']);
  assert.deepEqual(receipt.unavailable_capability_refs, []);

  const withoutCurrentDelta = buildCapabilityRegistryStageContextReceipt({
    lifecyclePhase: 'execution',
    domainId: 'medautoscience',
    stageId: 'review',
    taskId: 'task:capability-gate',
    capabilityRegistryResolutionReceipts: readout.resolutions,
  });
  assert.equal(withoutCurrentDelta.status, 'observed');
  assert.equal(withoutCurrentDelta.advisory_reason, null);
});

test('capability preflight records route-required misses without blocking stage execution', () => {
  const missingCapability = buildCapabilityRegistryStageContextReceipt({
    lifecyclePhase: 'execution',
    domainId: 'medautoscience',
    stageId: 'review',
    taskId: 'task:capability-gate',
    currentOwnerDelta: routeRequiredDelta,
    capabilityRegistryReadout: missingRouteReadout(),
    capabilityRegistryReadoutRef: 'opl://capability-readouts/review-source-route',
  });
  const unboundReadout = missingRouteReadout({
    ...routeRequiredDelta,
    task_or_study_ref: 'task:other',
  });
  const missingBinding = buildCapabilityRegistryStageContextReceipt({
    lifecyclePhase: 'execution',
    domainId: 'medautoscience',
    stageId: 'review',
    taskId: 'task:capability-gate',
    currentOwnerDelta: routeRequiredDelta,
    capabilityRegistryReadout: unboundReadout,
  });

  assert.equal(missingCapability.status, 'observed');
  assert.equal(missingCapability.advisory_reason, null);
  assert.deepEqual(missingCapability.unavailable_capability_refs, ['capability:review-source-route']);
  assert.equal(missingCapability.progression_effect, 'advisory_only_stage_may_start');
  assert.equal(missingBinding.status, 'observed');
  assert.equal(missingBinding.advisory_reason, null);
});

test('capability launch gate keeps missing source or reviewer capability fail-open for stage progress', () => {
  const sourceEvidenceDelta: CurrentOwnerDeltaCapabilityBinding = {
    ...routeRequiredDelta,
    required_capability_refs: [{
      ...routeRequiredDelta.required_capability_refs![0],
      hard_boundary: 'source_data_evidence',
    }],
  };
  const receipt = buildCapabilityRegistryStageContextReceipt({
    lifecyclePhase: 'execution',
    domainId: 'medautoscience',
    stageId: 'review',
    taskId: 'task:capability-gate',
    currentOwnerDelta: sourceEvidenceDelta,
    capabilityRegistryReadout: missingRouteReadout(sourceEvidenceDelta),
  });

  assert.equal(receipt.status, 'observed');
  assert.equal(receipt.advisory_reason, null);
  assert.deepEqual(receipt.unavailable_capability_refs, []);
  assert.deepEqual(receipt.optional_fail_open_capability_refs, ['capability:review-source-route']);
});

test('resolved route-required resolution without typed current-owner-delta remains advisory', () => {
  const resolution = resolvedRouteReadout().resolutions[0];
  const execution = buildCapabilityRegistryStageContextReceipt({
    lifecyclePhase: 'execution',
    domainId: 'medautoscience',
    stageId: 'review',
    taskId: 'task:capability-gate',
    capabilityRegistryResolutionReceipts: [resolution],
  });
  const planning = buildCapabilityRegistryStageContextReceipt({
    lifecyclePhase: 'planning',
    domainId: 'medautoscience',
    stageId: 'review',
    taskId: 'task:capability-gate',
    capabilityRegistryResolutionReceipts: [resolution],
  });

  assert.equal(execution.status, 'observed');
  assert.equal(execution.advisory_reason, null);
  assert.deepEqual(execution.binding_missing_capability_refs, ['capability:review-source-route']);
  assert.equal(planning.status, 'not_applicable');
  assert.equal(planning.advisory_reason, null);
});

test('route-required resolution binding must match the typed delta and launch context', () => {
  const resolution = resolvedRouteReadout().resolutions[0];
  const inconsistentInputs = [
    {
      name: 'launch stage',
      domainId: 'medautoscience' as const,
      stageId: 'analysis',
      resolution,
    },
    {
      name: 'resolution task or study ref',
      domainId: 'medautoscience' as const,
      stageId: 'review',
      resolution: { ...resolution, task_or_study_ref: 'study:other' },
    },
    {
      name: 'binding task or study ref',
      domainId: 'medautoscience' as const,
      stageId: 'review',
      resolution: {
        ...resolution,
        current_owner_delta_binding: {
          ...resolution.current_owner_delta_binding,
          task_or_study_ref: 'study:other',
        },
      },
    },
    {
      name: 'resolution stage ref',
      domainId: 'medautoscience' as const,
      stageId: 'review',
      resolution: { ...resolution, stage_ref: 'analysis' },
    },
    {
      name: 'binding stage ref',
      domainId: 'medautoscience' as const,
      stageId: 'review',
      resolution: {
        ...resolution,
        current_owner_delta_binding: {
          ...resolution.current_owner_delta_binding,
          stage_ref: 'analysis',
        },
      },
    },
    {
      name: 'binding domain',
      domainId: 'medautoscience' as const,
      stageId: 'review',
      resolution: {
        ...resolution,
        current_owner_delta_binding: {
          ...resolution.current_owner_delta_binding,
          domain: 'mag',
          domain_id: 'mag',
        },
      },
    },
    {
      name: 'binding delta ref',
      domainId: 'medautoscience' as const,
      stageId: 'review',
      resolution: {
        ...resolution,
        current_owner_delta_binding: {
          ...resolution.current_owner_delta_binding,
          current_owner_delta_ref: 'current-owner-delta:mas:other',
        },
      },
    },
    {
      name: 'hard boundary',
      domainId: 'medautoscience' as const,
      stageId: 'review',
      resolution: {
        ...resolution,
        route_required_policy: {
          ...resolution.route_required_policy,
          hard_boundary: 'forbidden_write' as const,
        },
      },
    },
    {
      name: 'launch domain',
      domainId: 'medautogrant' as const,
      stageId: 'review',
      resolution,
    },
  ];

  for (const input of inconsistentInputs) {
    const receipt = buildCapabilityRegistryStageContextReceipt({
      lifecyclePhase: 'execution',
      domainId: input.domainId,
      stageId: input.stageId,
      taskId: 'runtime-task:does-not-equal-study-ref',
      currentOwnerDelta: routeRequiredDelta,
      capabilityRegistryResolutionReceipts: [input.resolution],
    });

    assert.equal(receipt.status, 'observed', input.name);
    assert.equal(receipt.advisory_reason, null, input.name);
    assert.deepEqual(
      receipt.binding_missing_capability_refs,
      ['capability:review-source-route'],
      input.name,
    );
  }

  const allowed = buildCapabilityRegistryStageContextReceipt({
    lifecyclePhase: 'execution',
    domainId: 'medautoscience',
    stageId: 'review',
    taskId: 'runtime-task:does-not-equal-study-ref',
    currentOwnerDelta: routeRequiredDelta,
    capabilityRegistryResolutionReceipts: [resolution],
  });
  assert.equal(allowed.status, 'observed');
  assert.equal(allowed.advisory_reason, null);

  const undeclaredByDelta = buildCapabilityRegistryStageContextReceipt({
    lifecyclePhase: 'execution',
    domainId: 'medautoscience',
    stageId: 'review',
    taskId: 'runtime-task:does-not-equal-study-ref',
    currentOwnerDelta: {
      ...routeRequiredDelta,
      required_capability_refs: [],
    },
    capabilityRegistryResolutionReceipts: [resolution],
  });
  assert.equal(undeclaredByDelta.status, 'observed');
  assert.equal(undeclaredByDelta.advisory_reason, null);
});

test('malformed current-owner-delta preserves route-required refs as advisory debt', () => {
  const malformedPayloads = [
    { current_owner_delta: {
      ...routeRequiredDelta,
      schema_version: 'malformed-current-owner-delta.v0',
    } },
    { current_owner_delta: {
      ...routeRequiredDelta,
      task_or_study_ref: { malformed: true },
    } },
    {
      current_owner_delta: routeRequiredDelta,
      capability_registry_readout: {
        ...missingRouteReadout(),
        schema_version: 'malformed-capability-readout.v0',
      },
    },
  ];

  for (const payload of malformedPayloads) {
    const gateInput = capabilityRegistryStageContextInputFromPayload(payload, {
      domainId: 'medautoscience',
      stageId: 'review',
      taskId: 'task:capability-gate',
    });

    assert.ok(gateInput);
    const receipt = buildCapabilityRegistryStageContextReceipt(gateInput);
    assert.equal(receipt.status, 'observed');
    assert.equal(receipt.advisory_reason, null);
    assert.deepEqual(
      receipt.route_required_hard_boundary_capability_refs,
      ['capability:review-source-route'],
    );
    assert.deepEqual(receipt.binding_missing_capability_refs, ['capability:review-source-route']);
  }
});

test('explicit malformed capability scope remains advisory unless it proves optional-only', () => {
  const resolvedReadout = resolvedRouteReadout();
  const routeResolution = resolvedReadout.resolutions[0];
  const malformedPayloads = [
    {
      current_owner_delta: {
        ...routeRequiredDelta,
        required_capability_refs: {
          capability_ref: 'capability:review-source-route',
          binding_kind: 'route_required',
        },
      },
    },
    {
      current_owner_delta: {
        ...routeRequiredDelta,
        required_capability_refs: [{
          capability_ref: 'capability:review-source-route',
          binding_kind: 'route_required',
        }],
      },
    },
    {
      current_owner_delta: {
        ...routeRequiredDelta,
        required_capability_refs: [{
          capability_ref: 'capability:review-source-route',
          binding_kind: 'route_required',
          hard_boundary: 'not-a-hard-boundary',
        }],
      },
    },
    {
      capability_registry_resolution: {
        ...routeResolution,
        schema_version: 'malformed-capability-resolution.v0',
        route_required_policy: {
          ...routeResolution.route_required_policy,
          hard_boundary: null,
        },
      },
    },
    {
      capability_registry_readout: {
        ...resolvedReadout,
        schema_version: 'malformed-capability-readout.v0',
        resolutions: { malformed: true },
      },
    },
  ];

  for (const payload of malformedPayloads) {
    const gateInput = capabilityRegistryStageContextInputFromPayload(payload, {
      domainId: 'medautoscience',
      stageId: 'review',
      taskId: 'task:capability-gate',
    });

    assert.ok(gateInput);
    const receipt = buildCapabilityRegistryStageContextReceipt(gateInput);
    assert.equal(receipt.status, 'observed');
    assert.equal(receipt.advisory_reason, null);
  }
});

test('malformed current-owner-delta with optional-only requirements remains fail-open', () => {
  const gateInput = capabilityRegistryStageContextInputFromPayload({
    current_owner_delta: {
      ...routeRequiredDelta,
      schema_version: 'malformed-current-owner-delta.v0',
      required_capability_refs: [{
        capability_ref: 'capability:optional-review-aid',
        binding_kind: 'optional',
      }],
    },
  }, {
    domainId: 'medautoscience',
    stageId: 'review',
    taskId: 'task:capability-gate',
  });

  assert.ok(gateInput);
  const receipt = buildCapabilityRegistryStageContextReceipt(gateInput);
  assert.equal(receipt.status, 'not_applicable');
  assert.equal(receipt.advisory_reason, null);
  assert.deepEqual(receipt.unavailable_capability_refs, []);

  const optionalDelta: CurrentOwnerDeltaCapabilityBinding = {
    ...routeRequiredDelta,
    required_capability_refs: [{
      capability_ref: 'capability:optional-review-aid',
      binding_kind: 'optional',
    }],
  };
  const optionalResolution = buildCapabilityRegistryReadout({
    registry: emptyRegistry,
    currentOwnerDelta: optionalDelta,
    requestedCapabilities: [{
      capabilityRef: 'capability:optional-review-aid',
      taskOrStudyRef: 'task:capability-gate',
      stageRef: 'review',
      bindingKind: 'optional',
    }],
  }).resolutions[0];
  const malformedOptionalResolutionInput = capabilityRegistryStageContextInputFromPayload({
    capability_registry_resolution: {
      ...optionalResolution,
      schema_version: 'malformed-capability-resolution.v0',
      blocker_candidate: undefined,
      route_required_policy: {
        ...optionalResolution.route_required_policy,
        hard_boundary: undefined,
      },
    },
  }, {
    domainId: 'medautoscience',
    stageId: 'review',
    taskId: 'task:capability-gate',
  });

  assert.ok(malformedOptionalResolutionInput);
  const malformedOptionalResolutionReceipt = buildCapabilityRegistryStageContextReceipt(
    malformedOptionalResolutionInput,
  );
  assert.equal(malformedOptionalResolutionReceipt.status, 'not_applicable');
  assert.equal(malformedOptionalResolutionReceipt.advisory_reason, null);

  const invalidOptionalBoundaryInput = capabilityRegistryStageContextInputFromPayload({
    current_owner_delta: {
      ...routeRequiredDelta,
      schema_version: 'malformed-current-owner-delta.v0',
      required_capability_refs: [{
        capability_ref: 'capability:optional-review-aid',
        binding_kind: 'optional',
        hard_boundary: 'not-a-hard-boundary',
      }],
    },
  }, {
    domainId: 'medautoscience',
    stageId: 'review',
    taskId: 'task:capability-gate',
  });
  assert.ok(invalidOptionalBoundaryInput);
  const invalidOptionalBoundaryReceipt = buildCapabilityRegistryStageContextReceipt(
    invalidOptionalBoundaryInput,
  );
  assert.equal(invalidOptionalBoundaryReceipt.status, 'not_applicable');
  assert.equal(invalidOptionalBoundaryReceipt.advisory_reason, null);
  assert.deepEqual(invalidOptionalBoundaryReceipt.unavailable_capability_refs, []);
  assert.equal(
    invalidOptionalBoundaryReceipt.typed_input_status.unproven_explicit_capability_binding,
    false,
  );
});
}
