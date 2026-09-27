import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ResourceFiles, hash, MAX_CONTENT, userSemantics, type CleanupRoot, type InventoryFile } from './resource-files.ts';
export class WorkbenchMemory extends ResourceFiles {
readonly memoryRoot: string;
constructor(memoryRoot: string) { super(); this.memoryRoot = memoryRoot; }
async memoryList() { return { status: 'available', owner: 'Codex memory', scope: 'existing_codex_home', items: await this.files(this.memoryRoot, 'memory'), writePolicy: 'correction_notes_only' }; }

async memoryRead(id: string) {
    if (!Buffer.from(id.slice('memory:'.length), 'base64url').toString('utf8').endsWith('.md')) throw Error('Only memory Markdown references are readable.');
    const target = await this.resolve(id, 'memory', this.memoryRoot);
    const handle = await open(target.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await handle.stat()).size > MAX_CONTENT) throw new Error('Memory file is too large for inline editing.');
      return { id, revision: target.revision, content: await handle.readFile('utf8'), editable: target.relative.startsWith('extensions/ad_hoc/notes/') };
    } finally { await handle.close(); }
  }

async memoryCorrect(input: Record<string, unknown>, dryRun: boolean) {
    if (typeof input.content !== 'string' || !input.content.trim() || Buffer.byteLength(input.content) > MAX_CONTENT) throw new Error('Provide a correction of at most 128 KiB.');
    if (input.source_id) await this.resolve(String(input.source_id), 'memory', this.memoryRoot);
    await this.assertRoot(this.memoryRoot);
    const directory = path.join(this.memoryRoot, 'extensions/ad_hoc/notes');
    if (dryRun) return { status: 'preview', owner: 'Codex memory', summary: 'Create a user correction note for the memory owner. Canonical memory is preserved; processing happens later.' };
    // Reject symlinks in existing parents before creating the note directory.
    let parent = this.memoryRoot;
    for (const part of ['extensions', 'ad_hoc', 'notes']) {
      if (existsSync(parent) && (await lstat(parent)).isSymbolicLink()) throw new Error('Symbolic memory roots are not allowed.');
      parent = path.join(parent, part);
    }
    if (existsSync(directory) && (await lstat(directory)).isSymbolicLink()) throw new Error('Symbolic memory roots are not allowed.');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.md`;
    const content = `# User correction\n\n${input.source_id ? `Source reference: ${String(input.source_id)}\n\n` : ''}${input.content}\n`;
    await writeFile(path.join(directory, name), content, { flag: 'wx', mode: 0o600 });
    return { status: 'executed', summary: 'Correction note submitted. Canonical memory has not been rewritten.', effect: 'correction_note_created', id: `memory:${Buffer.from(`extensions/ad_hoc/notes/${name}`).toString('base64url')}` };
  }

async memoryNote(input: Record<string, unknown>, remove: boolean, dryRun: boolean) {
    return this.serialized(() => this.updateMemoryNote(input, remove, dryRun));
  }

private async updateMemoryNote(input: Record<string, unknown>, remove: boolean, dryRun: boolean) {
    const target = await this.resolve(String(input.id), 'memory', this.memoryRoot);
    if (!target.relative.startsWith('extensions/ad_hoc/notes/') || !target.relative.endsWith('.md')) throw new Error('Canonical memory is read-only; submit a correction note.');
    if (input.revision !== target.revision) throw new Error('Memory changed; reload before editing.');
    if (!remove && (typeof input.content !== 'string' || Buffer.byteLength(input.content) > MAX_CONTENT)) throw new Error('Invalid memory note content.');
    if (dryRun) return { status: 'preview', effect: remove ? 'delete_user_note' : 'update_user_note', id: input.id };
    if (remove) { if ((await this.resolve(String(input.id), 'memory', this.memoryRoot)).revision !== target.revision) throw Error('Memory changed; reload.'); await unlink(target.file); }
    else {
      const temporary = `${target.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, String(input.content), { flag: 'wx', mode: 0o600 });
      try {
        if ((await this.resolve(String(input.id), 'memory', this.memoryRoot)).revision !== target.revision) throw new Error('Memory changed; reload before editing.');
        await rename(temporary, target.file);
      } finally { await unlink(temporary).catch(() => undefined); }
    }
    return { status: 'executed', id: input.id };
  }
}
