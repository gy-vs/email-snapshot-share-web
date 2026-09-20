import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {Buffer} from 'node:buffer';
import {createApp,type AppOptions} from '../src/server/index';
import type {SnapshotStore} from '../src/server/snapshotStore';
import {sha256} from '../src/server/integrity';

// Controllable clock so TTL/expiry is deterministic.
function fakeClock(start = 1_000_000){
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => { current += ms; },
  };
}

function makeApp(clock = fakeClock(), ttlMs = 60_000, snapshotOptions: Partial<NonNullable<AppOptions['snapshot']>> = {}){
  return createApp({snapshot: {now: clock.now, ttlMs, ...snapshotOptions}});
}

const storeOf = (app: ReturnType<typeof createApp>) => app.locals.snapshotStore as SnapshotStore;

const pngPixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
).toString('base64');
const webpBytes = Buffer.from('RIFF fake webp payload for tests', 'utf8').toString('base64');

import type {SnapshotManifest} from '../src/shared/types';

async function createSnapshot(
  app: ReturnType<typeof createApp>,
  body: Record<string, unknown>,
){
  const response = await request(app).post('/api/snapshots').send(body).expect(201);
  return response.body as {id: string; shortLink: string; manifest: SnapshotManifest};
}

const alphaSnapshot = (resources: unknown[] = [], capabilities: Record<string, unknown> = {}) => ({
  templateId: 'alpha',
  revision: 3,
  capabilities,
  resources,
});

describe('snapshot basics', () => {
  it('pins template revision, capabilities and returns a local hash short link', async () => {
    const app = makeApp();
    const created = await createSnapshot(app, alphaSnapshot(
      [{cid: 'logo', contentType: 'image/png', contentBase64: pngPixel}],
      {images: false, css: false, viewportWidth: 480},
    ));

    expect(created.shortLink).toBe(`#/s/${created.id}`);
    expect(created.manifest).toMatchObject({
      templateId: 'alpha',
      templateRevision: 3,
      capabilities: {images: false, css: false, viewportWidth: 480},
    });
    expect(String(created.manifest.signature)).toMatch(/^[0-9a-f]{64}$/);

    const read = await request(app).get(`/api/snapshots/${created.id}`).expect(200);
    expect(read.body.readOnly).toBe(true);
    expect(read.body.templateRevision).toBe(3);
    expect(read.body.stale).toBe(false);
    // Frozen content is the exact seeded text, served even after drafts move on.
    expect(read.body.templateContent).toContain('render previews: alpha');
    expect(read.body.resources).toHaveLength(1);
    expect(read.body.resources[0].digest).toMatch(/^[0-9a-f]{64}$/);
    // MIME part locator and degradation explanation survive in read-only mode.
    expect(read.body.mimeParts.map((p: {path: string}) => p.path)).toEqual(['0', '1/0']);
    expect(read.body.degradation.some((n: {code: string}) => n.code === 'images_unavailable')).toBe(true);
    expect(read.body.degradation.some((n: {code: string}) => n.code === 'css_stripped')).toBe(false);
  });

  it('rejects snapshotting a revision that does not match the live one', async () => {
    const app = makeApp();
    const response = await request(app)
      .post('/api/snapshots')
      .send({templateId: 'alpha', capabilities: {}})
      .expect('Content-Type', /json/);
    // Body missing revision entirely -> 409.
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('revision_conflict');

    await request(app).post('/api/snapshots').send(alphaSnapshot()).expect(201);
    await request(app).put('/api/templates/alpha').send({content: 'changed', revision: 3}).expect(200);
    const stale = await request(app).post('/api/snapshots').send(alphaSnapshot()).expect(409);
    expect(stale.body.error).toBe('revision_conflict');
  });
});

describe('content-addressed resource deduplication', () => {
  it('stores identical content once even under different CIDs and snapshots', async () => {
    const app = makeApp();
    const store = storeOf(app);

    const first = await createSnapshot(app, alphaSnapshot([
      {cid: 'logo', contentType: 'image/png', contentBase64: pngPixel},
    ]));
    const blobsAfterFirst = store.blobs.size;
    // Pool contains: template content + the png.
    expect(blobsAfterFirst).toBe(2);

    const second = await createSnapshot(app, alphaSnapshot([
      {cid: 'logo', contentType: 'image/png', contentBase64: pngPixel},
      {cid: 'logo-copy-elsewhere', contentType: 'image/png', contentBase64: pngPixel},
    ]));

    // Same bytes -> same digest -> no new blob; only the manifest was added.
    expect(store.blobs.size).toBe(blobsAfterFirst);
    const firstDigest = first.manifest.resources[0].digest;
    expect(second.manifest.resources[0].digest).toBe(firstDigest);
    expect(second.manifest.resources[1].digest).toBe(firstDigest);
    expect(store.manifests.size).toBe(2);

    // Both snapshots still serve their own resource rows independently.
    for (const id of [first.id, second.id]) {
      const read = await request(app).get(`/api/snapshots/${id}`).expect(200);
      for (const resource of read.body.resources) {
        expect(resource.contentBase64).toBe(pngPixel);
      }
    }
  });

  it('dedups resources uploaded ahead of time through the resources endpoint', async () => {
    const app = makeApp();
    const store = storeOf(app);
    const uploaded = await request(app).post('/api/resources').send({
      cid: 'early',
      contentType: 'image/png',
      contentBase64: pngPixel,
    }).expect(200);
    expect(store.blobs.has(uploaded.body.digest)).toBe(true);

    const created = await createSnapshot(app, alphaSnapshot([
      {cid: 'later-cid', contentType: 'image/png', contentBase64: pngPixel},
    ]));
    expect(created.manifest.resources[0].digest).toBe(uploaded.body.digest);
    // No duplicate bytes were added to the pool.
    expect(store.blobs.size).toBe(2);

    await request(app).post('/api/resources').send({contentType: 'text/plain', contentBase64: 'not-base64!!'}).expect(400);
  });
});

describe('resource deletion and shared references', () => {
  it('refuses to delete a blob referenced by any live snapshot', async () => {
    const app = makeApp();
    const store = storeOf(app);
    const created = await createSnapshot(app, alphaSnapshot([
      {cid: 'logo', contentType: 'image/png', contentBase64: pngPixel},
    ]));
    const digest = created.manifest.resources[0].digest;

    await request(app).delete(`/api/resources/${digest}`).expect(409);
    // Blob and snapshot stay intact and readable.
    expect(store.blobs.has(digest)).toBe(true);
    await request(app).get(`/api/snapshots/${created.id}`).expect(200);

    // Template blob is protected too.
    await request(app).delete(`/api/resources/${created.manifest.templateDigest}`).expect(409);
  });

  it('allows deleting unreferenced uploads and never breaks snapshots sharing resources', async () => {
    const app = makeApp();
    const store = storeOf(app);
    const orphan = await request(app).post('/api/resources').send({
      cid: 'orphan',
      contentType: 'image/webp',
      contentBase64: webpBytes,
    }).expect(200);

    const sharedA = await createSnapshot(app, alphaSnapshot([
      {cid: 'a', contentType: 'image/png', contentBase64: pngPixel},
    ]));
    const shared = sharedA.manifest.resources[0].digest;
    const sharedB = await createSnapshot(app, {
      templateId: 'beta',
      revision: 5,
      resources: [{cid: 'b', contentType: 'image/png', contentBase64: pngPixel}],
    });
    expect(sharedB.manifest.resources[0].digest).toBe(shared);

    // Orphan upload can be removed; the shared png cannot.
    await request(app).delete(`/api/resources/${orphan.body.digest}`).expect(204);
    expect(store.blobs.has(orphan.body.digest)).toBe(false);
    await request(app).delete(`/api/resources/${shared}`).expect(409);

    // Even deleting one of the sharing snapshots must not remove the shared blob
    // while the other snapshot still references it.
    store.manifests.delete(sharedA.id);
    const cleanup = await request(app).post('/api/snapshots/cleanup').expect(200);
    expect(cleanup.body.removedSnapshots).toBe(0); // manually deleted, cleanup never saw it expired
    expect(store.blobs.has(shared)).toBe(true);
    await request(app).get(`/api/snapshots/${sharedB.id}`).expect(200);
  });
});

describe('manifest and content tampering', () => {
  it('rejects a manifest whose fields were altered after creation', async () => {
    const app = makeApp();
    const store = storeOf(app);
    const created = await createSnapshot(app, alphaSnapshot([
      {cid: 'logo', contentType: 'image/png', contentBase64: pngPixel},
    ]));
    const manifest = store.manifests.get(created.id)!;

    // Tamper with a pinned field without recomputing the HMAC.
    (manifest as unknown as {templateRevision: number}).templateRevision = 99;
    const failed = await request(app).get(`/api/snapshots/${created.id}`).expect(409);
    expect(failed.body.error).toBe('manifest_tampered');
    expect(failed.body).not.toHaveProperty('templateContent');
    expect(failed.body).not.toHaveProperty('resources');

    // Re-signing with the wrong key must not help: rotate secret by forging
    // signature to garbage.
    (manifest as unknown as {signature: string}).signature = '0'.repeat(64);
    const failedAgain = await request(app).get(`/api/snapshots/${created.id}`).expect(409);
    expect(failedAgain.body.error).toBe('manifest_tampered');
  });

  it('rejects altered or missing resource blobs and altered template bytes', async () => {
    const app = makeApp();
    const store = storeOf(app);
    const created = await createSnapshot(app, alphaSnapshot([
      {cid: 'logo', contentType: 'image/png', contentBase64: pngPixel},
    ]));
    const resourceDigest = created.manifest.resources[0].digest;

    // Overwrite the blob pool entry with different bytes under the same key.
    store.blobs.set(resourceDigest, Buffer.from('tampered bytes', 'utf8'));
    const failed = await request(app).get(`/api/snapshots/${created.id}`).expect(409);
    expect(failed.body.error).toBe('resource_integrity_failed');
    expect(failed.body).not.toHaveProperty('templateContent');

    // Restore resource, then remove it entirely.
    store.blobs.set(resourceDigest, Buffer.from(pngPixel, 'base64'));
    store.blobs.delete(resourceDigest);
    const missing = await request(app).get(`/api/snapshots/${created.id}`).expect(409);
    expect(missing.body.error).toBe('resource_integrity_failed');

    // Template content tampering is caught independently.
    store.blobs.set(resourceDigest, Buffer.from(pngPixel, 'base64'));
    store.blobs.set(
      created.manifest.templateDigest as string,
      Buffer.from('render previews: alpha\nstate: HACKED', 'utf8'),
    );
    const tamperedTemplate = await request(app).get(`/api/snapshots/${created.id}`).expect(409);
    expect(tamperedTemplate.body.error).toBe('resource_integrity_failed');
  });
});

describe('snapshot expiry', () => {
  it('stops serving after TTL and cleanup removes only unreferenced blobs', async () => {
    const clock = fakeClock();
    const app = makeApp(clock, 60_000);
    const store = storeOf(app);

    // The snapshot that will expire first: beta content + a webp resource that
    // nobody else references.
    const expires = await createSnapshot(app, {
      templateId: 'beta',
      revision: 5,
      resources: [{cid: 'only-here', contentType: 'image/webp', contentBase64: webpBytes}],
    });
    const exclusiveDigest = expires.manifest.resources[0].digest;

    clock.advance(20_000);
    // Later snapshot pins alpha + a png shared with nothing yet...
    const keepAlive = await createSnapshot(app, alphaSnapshot([
      {cid: 'logo', contentType: 'image/png', contentBase64: pngPixel},
    ]));
    const pngDigest = keepAlive.manifest.resources[0].digest;

    // ...and a third snapshot reuses that exact png (shared content, one blob).
    clock.advance(10_000);
    const alsoAlive = await createSnapshot(app, {
      templateId: 'alpha',
      revision: 3,
      resources: [{cid: 'logo-again', contentType: 'image/png', contentBase64: pngPixel}],
    });

    // At t=60_001 the first snapshot (t=0) is 1ms past its 60s TTL; the other
    // two (t=20_000, t=30_000) are still within theirs.
    clock.advance(30_001);
    await request(app).get(`/api/snapshots/${expires.id}`).expect(410);
    await request(app).get(`/api/snapshots/${keepAlive.id}`).expect(200);
    await request(app).get(`/api/snapshots/${alsoAlive.id}`).expect(200);

    const result = await request(app).post('/api/snapshots/cleanup').expect(200);
    expect(result.body.removedSnapshots).toBe(1);
    // Removed: beta template blob + webp blob (both only referenced by the
    // expired snapshot). Kept: alpha template + shared png, both still live.
    expect(result.body.removedBlobs).toBe(2);
    expect(store.blobs.has(exclusiveDigest)).toBe(false);
    expect(store.blobs.has(pngDigest)).toBe(true);
    expect(store.manifests.has(expires.id)).toBe(false);
    await request(app).get(`/api/snapshots/${keepAlive.id}`).expect(200);
    await request(app).get(`/api/snapshots/${alsoAlive.id}`).expect(200);

    // Expired ids are gone for good (404, not 410).
    await request(app).get(`/api/snapshots/${expires.id}`).expect(404);
  });
});

describe('template updated after snapshot', () => {
  it('keeps serving the frozen revision and flags the live revision drift', async () => {
    const clock = fakeClock();
    const app = makeApp(clock);
    const created = await createSnapshot(app, alphaSnapshot());

    // Edit the template twice after the snapshot was taken.
    for (const content of ['draft saved once', 'draft saved twice']) {
      const current = await request(app).get('/api/templates/alpha').expect(200);
      await request(app)
        .put('/api/templates/alpha')
        .send({content, revision: current.body.revision})
        .expect(200);
    }

    const read = await request(app).get(`/api/snapshots/${created.id}`).expect(200);
    expect(read.body.templateRevision).toBe(3);
    expect(read.body.currentTemplateRevision).toBe(5);
    expect(read.body.stale).toBe(true);
    expect(read.body.templateContent).toContain('state: active');
    expect(read.body.templateContent).not.toContain('draft saved');
    expect(read.body.readOnly).toBe(true);

    // The snapshot cannot be mistaken for the editable revision: live endpoint
    // serves new bytes while the snapshot still serves the pinned ones.
    const live = await request(app).get('/api/templates/alpha').expect(200);
    expect(live.body.content).toBe('draft saved twice');
    expect(live.body.revision).toBe(5);
  });
});

describe('read/cleanup race', () => {
  it('serializes cleanup behind an in-flight read (no half page)', async () => {
    let releaseRead: () => void = () => {};
    const gate = new Promise<void>(resolve => { releaseRead = resolve; });
    let cleanupStarted = false;
    const app = makeApp(fakeClock(), 60_000, {
      // Returns while the read lock is held (until releaseRead), and records
      // that cleanup is queued behind it.
      onReadAcquired: () => gate,
    });
    const created = await createSnapshot(app, alphaSnapshot([
      {cid: 'logo', contentType: 'image/png', contentBase64: pngPixel},
    ]));

    const events: string[] = [];
    // Dispatch the read; it parks with the read lock held at the gate.
    const inFlightRead = request(app)
      .get(`/api/snapshots/${created.id}`)
      .then(response => { events.push('read-resolved'); return response; });

    // Wait until the read has definitely acquired the lock and hit the gate.
    await new Promise(resolve => setTimeout(resolve, 50));

    // Dispatch cleanup: it must queue behind the active reader and cannot touch
    // the blob pool while the read is assembling its response.
    const blockedCleanup = request(app)
      .post('/api/snapshots/cleanup')
      .then(response => { events.push('cleanup-resolved'); cleanupStarted = true; return response; });
    await new Promise(resolve => setTimeout(resolve, 50));

    // Let the parked read finish. The read must resolve FIRST; cleanup only
    // after the read lock is released.
    releaseRead();
    const partial = await inFlightRead;
    expect(partial.status).toBe(200);
    // Complete page: every manifest-listed resource carries verified bytes.
    expect(partial.body.resources).toHaveLength(1);
    expect(partial.body.resources[0].contentBase64).toBe(pngPixel);
    expect(sha256(Buffer.from(partial.body.templateContent, 'utf8'))).toBe(
      partial.body.templateDigest,
    );
    expect(events[0]).toBe('read-resolved');
    expect(cleanupStarted).toBe(false);

    const cleanupResult = await blockedCleanup;
    // Nothing expired, so cleanup is a no-op; crucially it ran strictly after
    // the read released its lock, and could never have produced a half page.
    expect(cleanupResult.status).toBe(200);
    expect(cleanupResult.body).toEqual({removedSnapshots: 0, removedBlobs: 0});
    expect(events).toEqual(['read-resolved', 'cleanup-resolved']);
  });

  it('snapshot created while a previous one expires shares blobs without corruption', async () => {
    const clock = fakeClock();
    const app = makeApp(clock, 60_000);
    const first = await createSnapshot(app, alphaSnapshot([
      {cid: 'logo', contentType: 'image/png', contentBase64: pngPixel},
    ]));
    clock.advance(60_001);
    await request(app).post('/api/snapshots/cleanup').expect(200);
    await request(app).get(`/api/snapshots/${first.id}`).expect(404);

    // Revive: a new snapshot with the same template content interns the blob
    // again rather than observing a dangling digest.
    clock.advance(0);
    const reborn = await createSnapshot(app, alphaSnapshot([
      {cid: 'logo', contentType: 'image/png', contentBase64: pngPixel},
    ]));
    const read = await request(app).get(`/api/snapshots/${reborn.id}`).expect(200);
    expect(read.body.resources[0].contentBase64).toBe(pngPixel);
    expect(read.body.templateContent).toContain('render previews: alpha');
  });
});

describe('unknown and malformed input', () => {
  it('returns 404 for unknown snapshot/resource', async () => {
    const app = makeApp();
    await request(app).get('/api/snapshots/nope').expect(404);
    await request(app).delete('/api/resources/deadbeef').expect(404);
  });
});
