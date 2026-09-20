import {describe, expect, it} from 'vitest';
import {digestOf, SnapshotError, SnapshotStore} from '../src/server/snapshots';

const TTL = 1000;
const TEMPLATE = '<html><body><h1>Hello</h1><img src="cid:hero.webp"/></body></html>';

function makeClock(start = 1_000_000) {
  let t = start;
  return {now: () => t, advance: (ms: number) => { t += ms; }};
}

function makeStore(clock = makeClock()) {
  return {store: new SnapshotStore({secret: 'test-secret', ttlMs: TTL, now: clock.now}), clock};
}

function baseInput(overrides: Partial<Parameters<SnapshotStore['createSnapshot']>[0]> = {}) {
  return {
    templateId: 'alpha',
    revision: 3,
    templateContent: TEMPLATE,
    clientProfileId: 'outlook-desktop',
    resources: [{name: 'hero.webp', content: 'WEBP-BYTES'}],
    ...overrides,
  };
}

async function expectSnapshotError(promise: Promise<unknown>, code: string, status: number) {
  const error = await promise.then(
    () => { throw new Error(`expected ${code}, but the call succeeded`); },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SnapshotError);
  expect((error as SnapshotError).code).toBe(code);
  expect((error as SnapshotError).status).toBe(status);
}

describe('snapshot store', () => {
  it('deduplicates identical resource content across snapshots', async () => {
    const {store} = makeStore();
    const first = await store.createSnapshot(baseInput({
      resources: [
        {name: 'a.txt', content: 'same-bytes'},
        {name: 'b.txt', content: 'same-bytes'},
      ],
    }));
    const [a, b] = first.manifest.resources;
    expect(a.digest).toBe(b.digest);
    // template content + one shared resource body
    expect(store.debugResourceCount()).toBe(2);

    await store.createSnapshot(baseInput({resources: [{name: 'c.txt', content: 'same-bytes'}]}));
    // second snapshot reuses the same template body and resource body
    expect(store.debugResourceCount()).toBe(2);
  });

  it('rejects the read when a referenced resource was deleted', async () => {
    const {store} = makeStore();
    const {id, manifest} = await store.createSnapshot(baseInput());
    store.debugDeleteResource(manifest.resources[0].digest);
    await expectSnapshotError(store.readSnapshot(id), 'resource_missing', 409);
  });

  it('rejects the read when the pinned template content was deleted', async () => {
    const {store} = makeStore();
    const {id, manifest} = await store.createSnapshot(baseInput());
    store.debugDeleteResource(manifest.template.digest);
    await expectSnapshotError(store.readSnapshot(id), 'resource_missing', 409);
  });

  it('rejects the read when resource bytes no longer match the manifest digest', async () => {
    const {store} = makeStore();
    const {id, manifest} = await store.createSnapshot(baseInput());
    store.debugReplaceResource(manifest.resources[0].digest, 'forged-bytes');
    await expectSnapshotError(store.readSnapshot(id), 'resource_tampered', 409);
  });

  it('rejects the read when the manifest was tampered with', async () => {
    const {store} = makeStore();
    const {id} = await store.createSnapshot(baseInput());

    store.debugMutateManifest(id, manifest => { manifest.revision = 99; });
    await expectSnapshotError(store.readSnapshot(id), 'manifest_tampered', 409);
  });

  it('rejects the read when a manifest resource digest was tampered with', async () => {
    const {store} = makeStore();
    const {id} = await store.createSnapshot(baseInput());
    store.debugMutateManifest(id, manifest => { manifest.resources[0].digest = digestOf('attacker-content'); });
    await expectSnapshotError(store.readSnapshot(id), 'manifest_tampered', 409);
  });

  it('expires snapshots and cleanup eventually removes them', async () => {
    const {store, clock} = makeStore();
    const {id} = await store.createSnapshot(baseInput());
    await expect(store.readSnapshot(id)).resolves.toMatchObject({id});

    clock.advance(TTL + 1);
    await expectSnapshotError(store.readSnapshot(id), 'expired', 410);

    const report = await store.cleanup();
    expect(report.removedSnapshots).toEqual([id]);
    await expectSnapshotError(store.readSnapshot(id), 'not_found', 404);
  });

  it('keeps resources shared with a live snapshot when the other snapshot expires', async () => {
    const {store, clock} = makeStore();
    const shared = {name: 'shared.png', content: 'SHARED'};
    const a = await store.createSnapshot(baseInput({resources: [shared, {name: 'only-a.txt', content: 'A'}]}));
    clock.advance(400);
    const b = await store.createSnapshot(baseInput({
      templateContent: '<html><body><h1>Other</h1></body></html>',
      resources: [shared, {name: 'only-b.txt', content: 'B'}],
    }));
    // templateA, templateB, shared, only-a, only-b
    expect(store.debugResourceCount()).toBe(5);

    clock.advance(700); // t0+700: A expired (TTL 1000 from t0), B still valid (TTL 1000 from t0+400)
    const report = await store.cleanup();
    expect(report.removedSnapshots).toEqual([a.id]);

    const sharedDigest = digestOf('SHARED');
    expect(store.debugHasResource(sharedDigest)).toBe(true);
    expect(store.debugHasResource(digestOf('A'))).toBe(false);
    expect(store.debugHasResource(digestOf('B'))).toBe(true);

    const view = await store.readSnapshot(b.id);
    expect(view.resources.map(resource => resource.name).sort()).toEqual(['only-b.txt', 'shared.png']);
    expect(view.resources.find(resource => resource.name === 'shared.png')?.content).toBe('SHARED');
  });

  it('cleanup deletes only resources that no snapshot references', async () => {
    const {store} = makeStore();
    await store.createSnapshot(baseInput());
    const before = store.debugResourceCount();
    const report = await store.cleanup();
    expect(report).toEqual({removedSnapshots: [], removedResources: []});
    expect(store.debugResourceCount()).toBe(before);
  });

  it('a read that started while valid completes in full even if cleanup runs concurrently', async () => {
    // Clock stays at T0 for the create and the read's expiry check, then jumps
    // far past the TTL: cleanup observes the snapshot as expired mid-read.
    const T0 = 1_000_000;
    let nowCalls = 0;
    const now = () => { nowCalls += 1; return nowCalls <= 2 ? T0 : T0 + TTL * 10; };
    const store = new SnapshotStore({secret: 'test-secret', ttlMs: TTL, now});
    const {id} = await store.createSnapshot(baseInput({
      resources: [
        {name: 'one.txt', content: '1'},
        {name: 'two.txt', content: '2'},
        {name: 'three.txt', content: '3'},
      ],
    }));

    const [view, report] = await Promise.all([store.readSnapshot(id), store.cleanup()]);

    // The read returned a complete page: every resource present and digest-valid.
    expect(view.resources).toHaveLength(3);
    for (const resource of view.resources) expect(digestOf(resource.content)).toBe(resource.digest);
    expect(digestOf(view.template.content)).toBe(view.template.digest);
    // Cleanup still did its job afterwards.
    expect(report.removedSnapshots).toEqual([id]);
    await expectSnapshotError(store.readSnapshot(id), 'not_found', 404);
  });

  it('concurrent reads and cleanup never produce a partially assembled page', async () => {
    const {store} = makeStore();
    const {id} = await store.createSnapshot(baseInput({
      resources: Array.from({length: 6}, (_, index) => ({name: `r${index}.txt`, content: `content-${index}`})),
    }));
    const reads = Array.from({length: 20}, () => store.readSnapshot(id));
    const [views] = await Promise.all([Promise.all(reads), store.cleanup()]);
    for (const view of views) {
      expect(view.resources).toHaveLength(6);
      for (const resource of view.resources) expect(digestOf(resource.content)).toBe(resource.digest);
    }
  });

  it('pins degradations and MIME part locating info in the manifest', async () => {
    const {store} = makeStore();
    const {manifest} = await store.createSnapshot(baseInput({
      templateContent: '<html><body style="border-radius:8px"><style>@media (max-width:600px){}</style><img src="cid:hero.webp"/></body></html>',
      clientProfileId: 'outlook-desktop',
      resources: [{name: 'hero.webp', content: 'WEBP-BYTES'}],
    }));
    expect(manifest.analysis.mimeParts.map(part => part.contentType)).toEqual(['text/html', 'image/webp']);
    expect(manifest.analysis.mimeParts[0].digest).toBe(manifest.template.digest);

    const byFeature = new Map(manifest.analysis.degradations.map(item => [item.feature, item]));
    expect(byFeature.get('media-queries')).toMatchObject({partId: '1', line: 1});
    expect(byFeature.get('border-radius')).toMatchObject({partId: '1'});
    expect(byFeature.get('webp-image')).toMatchObject({partId: '2', line: null});
  });

  it('reports no degradations when the client supports every used feature', async () => {
    const {store} = makeStore();
    const {manifest} = await store.createSnapshot(baseInput({clientProfileId: 'apple-mail'}));
    expect(manifest.analysis.degradations).toEqual([]);
  });

  it('rejects unknown client profiles and invalid resources', async () => {
    const {store} = makeStore();
    await expectSnapshotError(store.createSnapshot(baseInput({clientProfileId: 'nope'})), 'unknown_client_profile', 400);
    await expectSnapshotError(store.createSnapshot(baseInput({resources: [{name: '', content: 'x'}]})), 'invalid_resource', 400);
    await expectSnapshotError(store.createSnapshot(baseInput({resources: [{name: 'a.txt', content: 'x'}, {name: 'a.txt', content: 'y'}]})), 'invalid_resource', 400);
  });
});
