import fs from 'node:fs';
import path from 'node:path';

import { FrameworkContractError, isRecord } from '../../kernel/contract-validation.ts';
import {
  assertFamilyActionHandlerRefsResolve,
  normalizeDomainHandlerRegistry,
  normalizeFamilyActionCatalog,
  type DomainHandlerRegistry,
  type FamilyActionCatalog,
} from '../../kernel/family-action-catalog-contract.ts';
import { parseJsonText } from '../../kernel/json-file.ts';
import { resolveContainedRepoJsonFile } from '../../kernel/repo-contained-json-file.ts';
import { fail } from './hosted-agent-runtime-binding-contract.ts';

function readRuntimePackJson(checkoutRoot: string, ref: string, label: string) {
  try {
    const resolved = resolveContainedRepoJsonFile(checkoutRoot, ref, label, 'hosted Agent runtime pack');
    const parsed = parseJsonText(fs.readFileSync(resolved.real_path, 'utf8'));
    if (!isRecord(parsed)) fail(`${label} must contain an object.`, { ref });
    return parsed;
  } catch (error) {
    if (error instanceof FrameworkContractError) throw error;
    fail(`${label} could not be resolved from the hosted Agent runtime pack.`, {
      ref,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function readHostedAgentRuntimeActionContracts(
  checkoutRoot: string,
  acceptedTargetDomainIds?: readonly string[],
) {
  let catalog: FamilyActionCatalog | null;
  let registry: DomainHandlerRegistry | null;
  try {
    catalog = normalizeFamilyActionCatalog(
      readRuntimePackJson(checkoutRoot, 'contracts/action_catalog.json', 'Hosted Agent action catalog'),
    );
    registry = fs.existsSync(path.join(checkoutRoot, 'contracts/domain_handler_registry.json'))
      ? normalizeDomainHandlerRegistry(
          readRuntimePackJson(
            checkoutRoot,
            'contracts/domain_handler_registry.json',
            'Hosted Agent handler registry',
          ),
        )
      : null;
    if (!catalog) fail('Hosted Agent action catalog is missing.');
    assertFamilyActionHandlerRefsResolve(catalog, registry);
    for (const action of catalog.actions) {
      if (!action.input_schema_ref.startsWith('opl://')) {
        readRuntimePackJson(checkoutRoot, action.input_schema_ref, `Hosted Agent action ${action.action_id} input schema`);
      }
      if (!action.output_schema_ref.startsWith('opl://')) {
        readRuntimePackJson(checkoutRoot, action.output_schema_ref, `Hosted Agent action ${action.action_id} output schema`);
      }
    }
  } catch (error) {
    if (error instanceof FrameworkContractError) throw error;
    fail('Hosted Agent action contracts are invalid.', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (acceptedTargetDomainIds && !acceptedTargetDomainIds.includes(catalog!.target_domain_id)) {
    fail('Hosted Agent action catalog target does not match the runtime binding.', {
      accepted_target_domain_ids: acceptedTargetDomainIds,
      catalog_target_domain_id: catalog!.target_domain_id,
    });
  }
  return { catalog: catalog!, registry };
}
