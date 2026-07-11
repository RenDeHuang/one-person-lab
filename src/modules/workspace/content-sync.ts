import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { saveCloudContentConflict } from './cloud-sync.ts';

type CloudOptions = {
  origin: string;
  workspaceId: string;
  sessionCookie: string;
  fetchImpl?: typeof fetch;
};

type Transfer = {
  transferId: string;
  path: string;
  digest: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  receivedChunks?: number[];
  status: string;
};

function sha256(body: Uint8Array | string) {
  return createHash('sha256').update(body).digest('hex');
}

function projectFiles(root: string) {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git' || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

async function jsonResponse(response: Response, operation: string) {
  if (!response.ok) throw new Error(`${operation} failed: ${response.status}`);
  return await response.json() as Transfer;
}

function validateTransfer(transfer: Transfer, expected: { transferId?: string; path: string; digest: string; size: number }) {
  if (
    typeof transfer.transferId !== 'string' || !transfer.transferId ||
    (expected.transferId !== undefined && transfer.transferId !== expected.transferId) ||
    transfer.path !== expected.path || transfer.digest !== expected.digest || transfer.size !== expected.size
  ) {
    throw new Error('content transfer identity mismatch');
  }
}

export async function uploadProjectFiles(options: CloudOptions & {
  organizationId: string;
  projectId: string;
  projectRoot: string;
  csrfToken: string;
}) {
  const root = fs.realpathSync(options.projectRoot);
  const files = projectFiles(root);
  let uploadedChunks = 0;
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = `/api/workspaces/${encodeURIComponent(options.workspaceId)}`;
  for (const absolute of files) {
    const relativePath = path.relative(root, absolute).split(path.sep).join('/');
    // ponytail: one-file buffering matches the first Fabric provider; stream when real file sizes require it.
    const body = fs.readFileSync(absolute);
    const digest = sha256(body);
    const create = await fetchImpl(new URL(`${base}/transfers`, options.origin), {
      method: 'POST',
      headers: {
        'content-type': 'application/json', cookie: options.sessionCookie, 'x-opl-csrf': options.csrfToken,
        'Idempotency-Key': sha256(`${options.workspaceId}\0${options.projectId}\0${relativePath}\0${digest}`),
      },
      body: JSON.stringify({ organizationId: options.organizationId, projectId: options.projectId, path: relativePath, digest, size: body.length }),
    });
    const created = await jsonResponse(create, 'content transfer create');
    const identity = { path: relativePath, digest, size: body.length };
    validateTransfer(created, identity);
    const status = await jsonResponse(await fetchImpl(new URL(`${base}/transfers/${encodeURIComponent(created.transferId)}`, options.origin), {
      headers: { cookie: options.sessionCookie },
    }), 'content transfer status');
    validateTransfer(status, { ...identity, transferId: created.transferId });
    if (status.status === 'completed') continue;
    if (!Number.isSafeInteger(status.chunkSize) || status.chunkSize < 1 || !Number.isSafeInteger(status.chunkCount) || status.chunkCount < 0) {
      throw new Error('content transfer status is invalid');
    }
    const receivedChunks = status.receivedChunks ?? [];
    if (receivedChunks.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= status.chunkCount) || new Set(receivedChunks).size !== receivedChunks.length) {
      throw new Error('content transfer received chunks are invalid');
    }
    if (status.chunkCount !== Math.ceil(body.length / status.chunkSize)) throw new Error('content transfer chunk count is invalid');
    const received = new Set(receivedChunks);
    for (let index = 0; index < status.chunkCount; index += 1) {
      if (received.has(index)) continue;
      const chunk = body.subarray(index * status.chunkSize, Math.min(body.length, (index + 1) * status.chunkSize));
      const response = await fetchImpl(new URL(`${base}/transfers/${encodeURIComponent(status.transferId)}/chunks/${index}`, options.origin), {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', cookie: options.sessionCookie, 'x-opl-csrf': options.csrfToken, 'X-Chunk-SHA256': sha256(chunk) },
        body: chunk,
      });
      await jsonResponse(response, 'content chunk upload');
      uploadedChunks += 1;
    }
    const completed = await jsonResponse(await fetchImpl(new URL(`${base}/transfers/${encodeURIComponent(status.transferId)}/complete`, options.origin), {
      method: 'POST', headers: { cookie: options.sessionCookie, 'x-opl-csrf': options.csrfToken },
    }), 'content transfer complete');
    validateTransfer(completed, { ...identity, transferId: created.transferId });
    if (completed.status !== 'completed') throw new Error('content transfer did not complete');
  }
  return { files: files.length, uploadedChunks };
}

function containedTarget(projectRoot: string, relativePath: string) {
  const root = fs.realpathSync(projectRoot);
  const target = path.resolve(root, relativePath);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) throw new Error('cloud content path escapes project root');
  let current = target;
  while (current !== root) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('cloud content path contains symlink');
    current = path.dirname(current);
  }
  return target;
}

function atomicWrite(target: string, body: Uint8Array) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, body, { mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export async function applyCloudContent(options: CloudOptions & {
  projectRoot: string;
  relativePath: string;
  digest: string;
}) {
  if (!/^[a-f0-9]{64}$/.test(options.digest)) throw new Error('cloud content digest is invalid');
  const target = containedTarget(options.projectRoot, options.relativePath);
  const response = await (options.fetchImpl ?? fetch)(new URL(
    `/api/workspaces/${encodeURIComponent(options.workspaceId)}/contents/${encodeURIComponent(options.digest)}`,
    options.origin,
  ), { headers: { cookie: options.sessionCookie } });
  if (!response.ok) throw new Error(`content download failed: ${response.status}`);
  if (response.headers.get('X-Content-SHA256') !== options.digest || response.headers.get('X-Workspace-Path') !== options.relativePath) {
    throw new Error('content download identity mismatch');
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (sha256(body) !== options.digest) throw new Error('content download digest mismatch');
  if (!fs.existsSync(target)) {
    atomicWrite(target, body);
    return { path: target, conflict: false };
  }
  const localDigest = sha256(fs.readFileSync(target));
  if (localDigest === options.digest) return { path: target, conflict: false };
  const conflictPath = `${target}.cloud-${options.digest.slice(0, 12)}`;
  if (fs.existsSync(conflictPath) && sha256(fs.readFileSync(conflictPath)) !== options.digest) {
    throw new Error('cloud conflict target is occupied');
  }
  if (!fs.existsSync(conflictPath)) atomicWrite(conflictPath, body);
  saveCloudContentConflict({
    workspaceId: options.workspaceId, path: options.relativePath, localDigest,
    remoteDigest: options.digest, preservedPath: path.relative(options.projectRoot, conflictPath).split(path.sep).join('/'),
  });
  return { path: conflictPath, conflict: true };
}
