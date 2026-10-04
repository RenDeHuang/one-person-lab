import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FrameworkContractError } from '../../kernel/contract-validation.ts';
import { fail } from './foundry-provider-stage-run-contract.ts';

function sha256(value: Buffer) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export interface FoundryProviderArtifactReader {
  readExact(input: { ref: string; sha256: string }): Buffer;
}

export class FileFoundryProviderArtifactReader implements FoundryProviderArtifactReader {
  readonly #allowedRoot: string;
  readonly #maxBytes: number;

  constructor(input: { allowed_root: string; max_bytes?: number }) {
    this.#allowedRoot = fs.realpathSync.native(input.allowed_root);
    this.#maxBytes = input.max_bytes ?? 4 * 1024 * 1024;
  }

  readExact(input: { ref: string; sha256: string }) {
    let candidate: string;
    try {
      const url = new URL(input.ref);
      if (url.protocol !== 'file:') fail('Foundry provider output must use an OPL-persisted file artifact ref.');
      candidate = fileURLToPath(url);
    } catch (error) {
      if (error instanceof FrameworkContractError) throw error;
      return fail('Foundry provider output artifact ref is invalid.', { artifact_ref: input.ref });
    }
    const stat = fs.lstatSync(candidate!);
    const real = fs.realpathSync.native(candidate!);
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || (real !== this.#allowedRoot && !real.startsWith(`${this.#allowedRoot}${path.sep}`))
      || stat.size <= 0
      || stat.size > this.#maxBytes
    ) {
      fail('Foundry provider output artifact is outside the allowed immutable transport boundary.', {
        artifact_ref: input.ref,
        size_bytes: stat.size,
      });
    }
    const bytes = fs.readFileSync(real);
    const expected = input.sha256.replace(/^sha256:/, '');
    if (!/^[a-f0-9]{64}$/.test(expected) || sha256(bytes) !== expected) {
      fail('Foundry provider output artifact bytes do not match the StageRun hash.', {
        artifact_ref: input.ref,
      });
    }
    return bytes;
  }
}
