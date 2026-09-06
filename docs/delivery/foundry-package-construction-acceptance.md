# Foundry Package Construction Acceptance

Tracks [issue #181](https://github.com/gaofeng21cn/one-person-lab/issues/181).
Comparison baseline: `892496cc29f40fe401e8bc9a9d8014502b86139c`.
The companion OMA admission fix is
[OMA PR #7](https://github.com/gaofeng21cn/opl-meta-agent/pull/7).

## Scope

IBD evidence assistance exposed failures in the generic hosted Agent construction
path. The previously delivered IBD candidate was materialized from recovered OMA
output using the existing compiler; that historical FoundryRun remained failed.
Its receipt does not prove an unmodified upstream hosted run succeeds.

This change ports the necessary normal-path fixes onto upstream, not the entire
divergent local runtime or its recovery implementation:

| Boundary | Upstream gap | Submitted correction |
| --- | --- | --- |
| Managed provider checkout | Required Connect Skill refresher was not composed | Compose existing descriptor discovery and pass the refresher; dispose on failure |
| Provider StageRun launch | Gateway flags disagreed with the real CLI parser | Use `--task` and `--input-artifact-sha256` |
| Stage routing | Host factory was not passed through the production kernel | Pass the existing Stagecraft composition to the gateway/runtime |
| Provider output | Strict consumer schema was absent from immutable input | Deliver canonical output schema closure and exact-byte requirements |
| Input evidence | Source-material refs did not deliver source bytes | Validate applied workspace intake receipts, use the existing content store, bind exact source artifacts to launch |
| Managed Attempt content | Manifest, policy and rubric refs lacked readable content | Hydrate their exact SHA/size-bound UTF-8 bytes into producer/reviewer input |
| Re-review | Nested closure field names were unspecified to the model | Project the machine contract with existing `status`/`summary` fields, without renaming the runtime protocol |
| Package verification | Compiler tests did not establish this combined admission path | Build two different target packages through the real Kernel and persist/read back materialization records |

No target-specific compiler, receipt issuer, source-binding registry, evaluator,
activation mode, or recovery state machine is introduced. Existing strict raw
output, identity, permissions, generation, resource hash and size checks remain.

## Reproduction

From a clean checkout with repository dependencies installed:

```sh
npm ci --ignore-scripts
npm run build:packages
scripts/run-with-repo-temp-env.sh node --experimental-strip-types --test \
  tests/src/foundry-agent-package-acceptance.test.ts \
  tests/src/foundry-provider-stage-run.test.ts \
  tests/src/foundry-source-material.test.ts \
  tests/src/foundry-managed-attempt-content.test.ts \
  tests/src/standard-agent-action-runtime.test.ts \
  tests/src/standard-agent-managed-checkout.test.ts \
  tests/src/stage-quality-finding-closure-prompt-contract.test.ts
scripts/verify.sh smoke
npm run typecheck
npm run build
npm run lint
```

The package acceptance uses an explicitly deterministic fixture gateway, the
real `StageRunFoundryProviderInvoker`, `ManifestFoundryDesignerAdapter`,
`FoundryKernel`, content-addressed compiler, file object store and SQLite ledger.
It creates IBD-evidence and publishing fixtures with different target identities,
domains, actions and Stages; both include all seven resource classes.

`startRun()` followed by the existing `advanceRunStep()` API reaches:

```text
accepted -> designing -> materializing -> evaluating
```

At this boundary the real ledger has `candidate_materialized`, whose
`candidate_record_digest` identifies an `opl_foundry_materialized_candidate`.
The test reads that object back and checks every indexed file's SHA/size,
candidate and manifest digests, resource bytes, and manifest conformance. Missing
bytes, hash mismatch and wrong generation must produce no materialization event.

The test deliberately stops before invoking evaluation. `evaluating` is not a
successful terminal FoundryRun and is not a newly introduced build-only policy.
No qualification, version registration, activation or target semantic quality
is inferred from this construction receipt. Temporary test artifacts are cleaned
up; the test does not publish or install its fixture packages.

## Remaining Live Acceptance

These checks establish deterministic construction and the previously broken
runtime boundaries. They do not run a real LLM through all hosted OMA Stages.
Before claiming complete unattended operation, run the public `engineer-agent`
action using the patched OPL checkout and the companion OMA change in an isolated,
fully installed runtime, and read the actual candidate event and object record.
An upstream default-provider fixture uses OMA 0.4.0; it is not evidence of a live
OMA 0.4.9 execution.

The upstream synchronous provider still has a 28-minute observation deadline and
its Temporal activity a 30-minute limit. Long multi-Stage runs can exceed them.
Stage recovery also does not resume an already failed FoundryRun. These remain
explicit follow-up work in #181, not silently fixed by increasing deadlines,
rewriting ledger terminal states, or importing the historical local coordinator.
