import { acquireManagedUpdateLock } from '../managed-update-lock.ts';
import { activatePendingCodexRuntimeGeneration } from './engine-helpers.ts';
import { activatePendingOplFrameworkRuntime, resolveFrameworkUpdateTargetRoot } from './framework-self-update.ts';
import { resolveProjectRoot } from './shared.ts';

type Activation = { status: string; [key: string]: unknown };

function activate(owner: () => Activation): Activation {
  try {
    const result = owner();
    return result.status === 'manual_required' ? {
      ...result,
      recovery: { action: 'continue_current_runtime', repair_command: ['opl', 'update', 'apply', '--json'] },
    } : result;
  } catch (error) {
    return {
      status: 'failed', reason: 'pending_generation_activation_failed',
      error: error instanceof Error ? error.message : String(error),
      recovery: { action: 'inspect_current_runtime', rollback_command: ['opl', 'update', 'rollback', '--json'] },
    };
  }
}

// This path deliberately does not enter startup-maintenance or update projection.
export function activatePendingRuntimeGenerations() {
  let lock: ReturnType<typeof acquireManagedUpdateLock>;
  try {
    lock = acquireManagedUpdateLock({ operation: 'apply', componentId: 'opl_base' });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'managed_update_lock_contention') throw error;
    return {
      version: 'g2', runtime_activation: {
        status: 'lock_contended', codex: { status: 'not_run' }, framework: { status: 'not_run' },
        recovery: { retry_command: ['opl', 'update', 'activate', '--json'] },
      },
    };
  }
  try {
    const codex = activate(activatePendingCodexRuntimeGeneration);
    const framework = activate(() => activatePendingOplFrameworkRuntime(resolveFrameworkUpdateTargetRoot(resolveProjectRoot())));
    const states = [codex.status, framework.status];
    const status = ['failed', 'manual_required', 'deferred_same_app_instance', 'activated']
      .find((candidate) => states.includes(candidate)) ?? 'no_pending_generation';
    return {
      version: 'g2', runtime_activation: {
        status, codex, framework,
        lock: { lock_id: lock.lock_id, status: 'released' },
        rollback_command: states.includes('activated') ? ['opl', 'update', 'rollback', '--json'] : null,
      },
    };
  } finally {
    lock.release();
  }
}
