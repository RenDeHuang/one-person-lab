import test from 'node:test';
import assert from 'node:assert/strict';
import { compareDependencyVersions, resolveDependencyRelease, resolveDependencyReleases } from '../../src/adapters/integration/dependency-release-resolution.ts';

test('dependency version comparison preserves a newer installed release', () => {
  assert.equal(compareDependencyVersions('0.6.6', '0.5.4'), 1);
  assert.equal(compareDependencyVersions('v1.9.1', '1.9.1'), 0);
});

test('manifest resolution uses the official platform archive and digest', async () => {
  const manifest = { version: '0.6.6', app: { url: 'https://cdn.kimi.com/kimi-computer-use/0.6.6/KimiCU.app.zip', sha256: '42cb1b1dcf591df766111e7cb6d075451f0caf0b94f0cad923505fd0d4bf3886', team_id: '2J9472RW75' } };
  const policy = { schema_version: 'test', sources: { 'kimi-cu': { kind: 'json-manifest' as const, url: 'https://cdn.kimi.com/kimi-computer-use/latest/version.json', platforms: { 'darwin-arm64': 'app' } } } };
  const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } });
  const resolved = await resolveDependencyRelease('kimi-cu', { policy, platform: 'darwin', architecture: 'arm64', fetch, verifyArchive: false });
  assert.equal(resolved.version, '0.6.6');
  assert.equal(resolved.archive_sha256, manifest.app.sha256);
  assert.equal(resolved.archive_url, manifest.app.url);
});

test('batch resolution rejects duplicate identities and freezes each result', async () => {
  await assert.rejects(() => resolveDependencyReleases(['x', 'x'], { policy: { schema_version: 'test', sources: {} } }), /only once/);
  const policy = { schema_version: 'test', sources: { x: { kind: 'json-manifest' as const, url: 'https://example.test/version.json', platforms: { 'darwin-arm64': 'app' } } } };
  const fetch = async () => new Response(JSON.stringify({ version: '1.0.0', app: { url: 'https://example.test/1.0.0/a.zip', sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }));
  const [result] = await resolveDependencyReleases(['x'], { policy, platform: 'darwin', architecture: 'arm64', fetch, verifyArchive: false });
  assert.equal(Object.isFrozen(result), true);
});
