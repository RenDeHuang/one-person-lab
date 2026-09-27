import { WorkbenchMemory } from './memory.ts';
import { WorkbenchStorage } from './storage.ts';
import type { CleanupRoot } from './resource-files.ts';
/** Compatibility facade; implementations and mutation state remain in their domain services. */
export class WorkbenchResources {
readonly memory: WorkbenchMemory;
readonly storage: WorkbenchStorage;
constructor(memoryRoot: string, cleanupRoots: CleanupRoot[], inventoryRoots: CleanupRoot[] = [], receiptRoot: string | null = null) {
this.memory = new WorkbenchMemory(memoryRoot);
this.storage = new WorkbenchStorage(cleanupRoots, inventoryRoots, receiptRoot);
}
 memoryList(...args: Parameters<WorkbenchMemory['memoryList']>) { return this.memory.memoryList(...args); }
 memoryRead(...args: Parameters<WorkbenchMemory['memoryRead']>) { return this.memory.memoryRead(...args); }
 memoryCorrect(...args: Parameters<WorkbenchMemory['memoryCorrect']>) { return this.memory.memoryCorrect(...args); }
 memoryNote(...args: Parameters<WorkbenchMemory['memoryNote']>) { return this.memory.memoryNote(...args); }
 inventory(...args: Parameters<WorkbenchStorage['inventory']>) { return this.storage.inventory(...args); }
 cleanupPreview(...args: Parameters<WorkbenchStorage['cleanupPreview']>) { return this.storage.cleanupPreview(...args); }
 cleanupExecute(...args: Parameters<WorkbenchStorage['cleanupExecute']>) { return this.storage.cleanupExecute(...args); }
}
