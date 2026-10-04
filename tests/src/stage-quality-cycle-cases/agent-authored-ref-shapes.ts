// Regression coverage for agent-authored ref lists.
//
// The Stage contract publishes some locators to Codex Attempts as *objects*: the reviewer is
// told to read review content from `opl_reviewer_input_snapshot_manifest.members[].immutable_ref`,
// whose schema shape is an exact ref (`{kind, ref, size_bytes, sha256}`). An Attempt that
// faithfully cites that locator therefore submits the object, not a bare string. The validators
// used to require `string[]` and rejected those submissions as `contract_shape_invalid`, which
// hard-stopped a whole StageRun after a full producer turn. These cases pin the accepted shapes
// (locator string or exact ref) and keep every genuinely malformed entry fail-closed.
import { test, assert } from './shared.ts';
import {
  evaluateStageQualityFindingClosure,
  validateStageQualityFindings,
  validateStageQualityRepairMap,
  validateStageQualityReviewHardStopOutcome,
} from '../../../src/authority/stages/stage-quality-cycle.ts';
import { normalizeDeclaredStageRouteDecision } from '../../../src/authority/stages/stage-quality-route-selection.ts';
import { FrameworkContractError } from '../../../src/authority/contracts/contracts.ts';

const LOCATOR = 'file:///workspace/studies/demo/artifacts/manuscript_canonical.md';
const EXACT_REF = {
  kind: 'opl_reviewer_input_snapshot_member',
  ref: LOCATOR,
  size_bytes: 20888,
  sha256: 'sha256:5bc7d772a55862c89dbeb4e1ee24d8a64cab80dd701d306086e514e8ac08829d',
};

function finding(evidence_refs: unknown) {
  return {
    finding_id: 'REV-MED-001',
    severity: 'major',
    required: true,
    summary: 'Upstream evidence gap is not closed at the earliest owning stage.',
    evidence_refs,
    repair_expectation: 'Close the gap at the owning stage before re-review.',
  };
}

test('stage quality findings accept the framework-published exact ref alongside the locator string', () => {
  const findings = validateStageQualityFindings([finding([EXACT_REF])] as never);
  assert.deepEqual(findings[0]!.evidence_refs, [LOCATOR]);
  assert.deepEqual(validateStageQualityFindings([finding([LOCATOR])] as never)[0]!.evidence_refs, [LOCATOR]);
  // Mixed shapes dedupe to one locator rather than failing or double-counting.
  assert.deepEqual(validateStageQualityFindings([finding([EXACT_REF, LOCATOR])] as never)[0]!.evidence_refs, [LOCATOR]);
});

test('stage quality repair map, closure and observations accept the same exact ref shape', () => {
  const findings = [finding([EXACT_REF])] as never;
  const repairMap = validateStageQualityRepairMap({
    findings,
    repairMap: [{
      finding_id: 'REV-MED-001',
      repair_status: 'repaired',
      changed_artifact_refs: [EXACT_REF],
      repair_evidence_refs: [EXACT_REF],
    }] as never,
  });
  assert.deepEqual(repairMap[0]!.changed_artifact_refs, [LOCATOR]);
  assert.deepEqual(repairMap[0]!.repair_evidence_refs, [LOCATOR]);
  assert.equal(evaluateStageQualityFindingClosure({
    findings,
    repairMap,
    reReview: {
      finding_closures: [{ finding_id: 'REV-MED-001', status: 'closed', evidence_refs: [EXACT_REF] }],
      repair_regressions: [],
      critical_new_findings: [],
      optional_observations: [{
        observation_id: 'OBS-1',
        summary: 'Remaining stylistic note.',
        evidence_refs: [EXACT_REF],
      }],
    },
  } as never).trigger_repair, false);
});

test('route decision evidence accepts the exact ref shape without silently dropping the route', () => {
  const decision = normalizeDeclaredStageRouteDecision({
    value: { decision_kind: 'complete', evidence_refs: [EXACT_REF] },
    declaredStageIds: ['manuscript_authoring', 'review_and_quality_gate'],
  });
  assert.deepEqual(decision.rejection_reasons, []);
  assert.deepEqual(decision.decision, { decision_kind: 'complete', evidence_refs: [LOCATOR] });
});

test('malformed agent-authored refs stay fail-closed', () => {
  for (const malformed of [7, '', '   ', {}, { ref: '' }, { ref: 42 }, null, []]) {
    assert.throws(
      () => validateStageQualityFindings([finding([malformed])] as never),
      FrameworkContractError,
      `expected rejection for ${JSON.stringify(malformed)}`,
    );
  }
  const route = normalizeDeclaredStageRouteDecision({
    value: { decision_kind: 'complete', evidence_refs: [{}] },
    declaredStageIds: ['manuscript_authoring', 'review_and_quality_gate'],
  });
  assert.deepEqual(route.rejection_reasons, ['route_selection_requires_evidence_refs']);
  assert.equal(route.decision, null);
});

test('hard-stop envelope blocker and human-gate refs accept the exact ref shape and fail closed', () => {
  const hardStop = (envelope: Record<string, unknown>) => validateStageQualityReviewHardStopOutcome({
    outcome: 'blocked',
    envelope: { hard_stop_class: 'stale_or_mismatched_stage_identity', blocked_reason: 'x', ...envelope },
  });
  // The Attempt cited the blocker as the exact-ref object the framework published.
  assert.deepEqual(
    hardStop({ typed_blocker_refs: [EXACT_REF] }).typed_blocker_refs,
    [LOCATOR],
  );
  assert.deepEqual(hardStop({ typed_blocker_ref: EXACT_REF }).typed_blocker_refs, [LOCATOR]);
  assert.deepEqual(hardStop({ typed_blocker_refs: [LOCATOR] }).typed_blocker_refs, [LOCATOR]);
  // A malformed or absent blocker ref still fails closed with the same domain error.
  assert.throws(() => hardStop({ typed_blocker_refs: [{}] }), FrameworkContractError);
  assert.throws(() => hardStop({ typed_blocker_refs: [7] }), FrameworkContractError);
  assert.throws(() => hardStop({}), FrameworkContractError);

  const humanGate = validateStageQualityReviewHardStopOutcome({
    outcome: 'human_gate',
    envelope: { hard_stop_class: 'human_decision_required', blocked_reason: 'x', human_gate_refs: [EXACT_REF] },
  });
  assert.deepEqual(humanGate.human_gate_refs, [LOCATOR]);
});
