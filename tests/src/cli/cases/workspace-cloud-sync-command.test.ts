import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { parseJsonText } from '../../../../src/kernel/json-file.ts';
import { assert, fs, os, path, runCli, runCliAsync, test } from '../helpers.ts';

test('workspace sync CLI queues, pushes, pulls, and keeps credentials out of state', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-workspace-sync-cli-'));
  const requests: Array<{ method: string; headers: Record<string, string | string[] | undefined> }> = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? '', headers: request.headers });
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST') {
      response.statusCode = 201;
      response.end(JSON.stringify({ status: 'accepted', projectId: 'project-alpha', taskId: '' }));
      return;
    }
    response.end(JSON.stringify({
      changes: [{ id: 'event-one', cursor: 1, status: 'accepted', payload: { title: 'Cloud' } }],
      nextCursor: 1,
      hasMore: false,
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = {
    OPL_STATE_DIR: stateDir,
    OPL_CLOUD_SESSION: 'opl_session=session-secret',
    OPL_CLOUD_CSRF: 'csrf-secret',
    OPL_CLOUD_ORGANIZATION_ID: 'org-alpha',
    OPL_CLOUD_CLIENT_ID: 'client-alpha',
  };
  try {
    assert.deepEqual(
      runCli(['help', 'workspace']).help.subcommands
        .filter((entry: { command: string }) => entry.command.startsWith('workspace sync'))
        .map((entry: { command: string }) => entry.command),
      [
        'workspace sync status',
        'workspace sync queue',
        'workspace sync push',
        'workspace sync pull',
        'workspace sync conflicts',
        'workspace sync upload',
        'workspace sync apply-content',
      ],
    );
    const queued = runCli([
      'workspace', 'sync', 'queue', '--workspace', 'workspace-alpha', '--entity', 'project',
      '--local-id', 'local-project-alpha', '--project-id', 'project-alpha', '--base-version', '1',
      '--operation-id', 'operation-alpha', '--operation', 'replace', '--payload', '{"title":"Local"}',
    ], env);
    assert.equal(queued.workspace_sync.queued.status, 'pending');
    assert.equal(runCli(['workspace', 'sync', 'status', '--workspace', 'workspace-alpha'], env)
      .workspace_sync.pending_count, 1);

    const pushed = await runCliAsync([
      'workspace', 'sync', 'push', '--origin', origin, '--workspace', 'workspace-alpha',
      '--session-cookie-env', 'OPL_CLOUD_SESSION', '--csrf-env', 'OPL_CLOUD_CSRF',
    ], env);
    const pulled = await runCliAsync([
      'workspace', 'sync', 'pull', '--origin', origin, '--workspace', 'workspace-alpha',
      '--session-cookie-env', 'OPL_CLOUD_SESSION',
    ], env);
    assert.deepEqual(pushed.workspace_sync, { applied: 1, conflicts: 0, pending: 0 });
    assert.deepEqual(pulled.workspace_sync, { applied: 1, conflicts: 0, cursor: 1, hasMore: false });
    assert.deepEqual(runCli(['workspace', 'sync', 'conflicts', '--workspace', 'workspace-alpha'], env)
      .workspace_sync.conflicts, []);
    assert.equal(requests[0].headers.cookie, 'opl_session=session-secret');
    assert.equal(requests[0].headers['x-opl-csrf'], 'csrf-secret');
    assert.doesNotMatch(JSON.stringify({ pushed, pulled }), /session-secret|csrf-secret/);
    for (const file of fs.readdirSync(path.join(stateDir, 'cloud-sync'))) {
      const bytes = fs.readFileSync(path.join(stateDir, 'cloud-sync', file));
      assert.equal(bytes.includes(Buffer.from('session-secret')), false);
      assert.equal(bytes.includes(Buffer.from('csrf-secret')), false);
    }
  } finally {
    server.close();
    await once(server, 'close');
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('workspace sync CLI uploads and atomically applies verified content', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-workspace-content-cli-'));
  fs.writeFileSync(path.join(projectRoot, 'local.txt'), 'local content');
  const remote = Buffer.from('cloud content');
  const remoteDigest = createHash('sha256').update(remote).digest('hex');
  let transfer: Record<string, unknown> = {};
  let uploaded = Buffer.alloc(0);
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://local').pathname;
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && pathname.endsWith('/transfers')) {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const input = parseJsonText(raw) as Record<string, unknown>;
      transfer = { ...input, transferId: 'transfer-alpha', chunkSize: 4 << 20, chunkCount: 1, receivedChunks: [], status: 'uploading' };
      response.statusCode = 201;
      response.end(JSON.stringify(transfer));
      return;
    }
    if (request.method === 'GET' && pathname.endsWith('/transfers/transfer-alpha')) {
      response.end(JSON.stringify(transfer));
      return;
    }
    if (request.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      uploaded = Buffer.concat(chunks);
      response.end(JSON.stringify(transfer));
      return;
    }
    if (request.method === 'POST' && pathname.endsWith('/complete')) {
      response.end(JSON.stringify({ ...transfer, status: 'completed' }));
      return;
    }
    if (request.method === 'GET' && pathname.includes('/contents/')) {
      response.setHeader('content-type', 'application/octet-stream');
      response.setHeader('X-Content-SHA256', remoteDigest);
      response.setHeader('X-Workspace-Path', 'cloud.txt');
      response.end(remote);
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = { OPL_CLOUD_SESSION: 'opl_session=secret', OPL_CLOUD_CSRF: 'csrf-secret' };
  try {
    const upload = await runCliAsync([
      'workspace', 'sync', 'upload', '--origin', origin, '--workspace', 'workspace-alpha',
      '--organization', 'org-alpha', '--project', 'project-alpha', '--project-root', projectRoot,
      '--session-cookie-env', 'OPL_CLOUD_SESSION', '--csrf-env', 'OPL_CLOUD_CSRF',
    ], env);
    const uploadSync = upload.workspace_sync as { content_upload: { files: number; uploadedChunks: number } };
    assert.deepEqual(uploadSync.content_upload, { files: 1, uploadedChunks: 1 });
    assert.equal(uploaded.toString(), 'local content');
    const applied = await runCliAsync([
      'workspace', 'sync', 'apply-content', '--origin', origin, '--workspace', 'workspace-alpha',
      '--project-root', projectRoot, '--path', 'cloud.txt', '--digest', remoteDigest,
      '--session-cookie-env', 'OPL_CLOUD_SESSION',
    ], env);
    const applySync = applied.workspace_sync as { content_apply: { conflict: boolean } };
    assert.equal(applySync.content_apply.conflict, false);
    assert.equal(fs.readFileSync(path.join(projectRoot, 'cloud.txt'), 'utf8'), 'cloud content');
  } finally {
    server.close();
    await once(server, 'close');
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
