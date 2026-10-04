import type { DatabaseSync } from 'node:sqlite';

import { canonicalJsonText } from '../../../kernel/canonical-json.ts';
import { FrameworkContractError } from '../../../kernel/contract-validation.ts';
import {
  DEFAULT_STAGE_RUN_START_LEASE_MS,
  type StageRunLaunchRow,
  type StageRunRecoveryRun,
} from './types.ts';

export function nowIso(now?: Date) {
  return (now ?? new Date()).toISOString();
}

export function validLeaseMs(value: number | undefined) {
  if (value === undefined) return DEFAULT_STAGE_RUN_START_LEASE_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > 5 * 60_000) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'StageRun start claim lease must be an integer between 1 ms and 5 minutes.',
      { lease_ms: value },
    );
  }
  return value;
}

export function activeStartingLease(row: StageRunLaunchRow, now: Date) {
  if (row.launch_status !== 'starting' || !row.start_claim_token || !row.start_lease_expires_at) {
    return false;
  }
  const expiresAt = Date.parse(row.start_lease_expires_at);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

export function activeRecoveryStartingLease(entry: StageRunRecoveryRun, now: Date) {
  if (entry.start_status !== 'starting' || !entry.start_claim_token || !entry.start_lease_expires_at) return false;
  const expiresAt = Date.parse(entry.start_lease_expires_at);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

export function writeRecoveryRuns(
  db: DatabaseSync,
  row: StageRunLaunchRow,
  receipt: Record<string, unknown>,
  runs: StageRunRecoveryRun[],
  now: Date,
) {
  db.prepare(`
    UPDATE stage_run_launches
    SET temporal_start_receipt_json = ?, updated_at = ?
    WHERE stage_run_id = ?
  `).run(canonicalJsonText({ ...receipt, recovery_runs: runs }), nowIso(now), row.stage_run_id);
}
