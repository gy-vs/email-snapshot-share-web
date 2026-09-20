import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {SnapshotStore} from '../src/server/snapshots';

describe('service',()=>{
  it('loads and conditionally updates a record',async()=>{
    const app=createApp();
    const before=await request(app).get('/api/templates/alpha').expect(200);
    await request(app).put('/api/templates/alpha').send({content:'updated',revision:before.body.revision}).expect(200);
    await request(app).put('/api/templates/alpha').send({content:'stale',revision:before.body.revision}).expect(409);
  });
});

describe('snapshot api',()=>{
  type App=ReturnType<typeof createApp>;
  function makeApi(ttlMs=60_000){
    let t=1_000_000;
    const store=new SnapshotStore({secret:'api-test-secret',ttlMs,now:()=>t});
    return {app:createApp({store}),store,advance:(ms:number)=>{t+=ms}};
  }
  async function currentRevision(app:App):Promise<number>{
    const response=await request(app).get('/api/templates/alpha').expect(200);
    return response.body.revision;
  }
  function createSnapshot(app:App,revision:number,resources=[{name:'hero.webp',content:'WEBP-BYTES'}]){
    return request(app).post('/api/snapshots').send({templateId:'alpha',revision,clientProfileId:'outlook-desktop',resources});
  }

  it('creates a pinned snapshot and reads it back with verified content',async()=>{
    const {app}=makeApi();
    const created=await createSnapshot(app,await currentRevision(app)).expect(201);
    expect(created.body.url).toBe(`/#/s/${created.body.id}`);
    expect(created.body.manifest.revision).toBe(3);

    const view=await request(app).get(`/api/snapshots/${created.body.id}`).expect(200);
    expect(view.body.manifest.templateId).toBe('alpha');
    expect(view.body.template.content).toContain('render previews: alpha');
    expect(view.body.resources).toEqual([expect.objectContaining({name:'hero.webp',content:'WEBP-BYTES'})]);
    expect(view.body.currentRevision).toBe(view.body.manifest.revision);
    expect(view.body.manifest.analysis.clientProfile.id).toBe('outlook-desktop');
  });

  it('rejects snapshot creation for a stale revision, unknown template and unknown profile',async()=>{
    const {app}=makeApi();
    await request(app).post('/api/snapshots').send({templateId:'alpha',revision:999,clientProfileId:'outlook-desktop',resources:[]}).expect(409,{error:'revision_conflict',message:'template alpha is at revision 3'});
    await request(app).post('/api/snapshots').send({templateId:'ghost',revision:1,clientProfileId:'outlook-desktop',resources:[]}).expect(404);
    await request(app).post('/api/snapshots').send({templateId:'alpha',revision:3,clientProfileId:'nope',resources:[]}).expect(400);
  });

  it('keeps serving the pinned revision after the template is updated later',async()=>{
    const {app}=makeApi();
    const created=await createSnapshot(app,await currentRevision(app)).expect(201);
    await request(app).put('/api/templates/alpha').send({content:'<html><body>rewritten draft</body></html>',revision:3}).expect(200);

    const view=await request(app).get(`/api/snapshots/${created.body.id}`).expect(200);
    expect(view.body.manifest.revision).toBe(3);
    expect(view.body.currentRevision).toBe(4);
    expect(view.body.template.content).toContain('render previews: alpha');
    expect(view.body.resources[0].content).toBe('WEBP-BYTES');
  });

  it('returns 404 for unknown snapshots and 410 once expired',async()=>{
    const {app,advance}=makeApi();
    await request(app).get('/api/snapshots/zzzzzzzz').expect(404,{error:'not_found',message:'unknown snapshot: zzzzzzzz'});
    const created=await createSnapshot(app,await currentRevision(app)).expect(201);
    advance(60_001);
    await request(app).get(`/api/snapshots/${created.body.id}`).expect(410);
    const cleanup=await request(app).post('/api/maintenance/cleanup').expect(200);
    expect(cleanup.body.removedSnapshots).toEqual([created.body.id]);
    await request(app).get(`/api/snapshots/${created.body.id}`).expect(404);
  });

  it('rejects tampered manifests and missing resources with 409',async()=>{
    const {app,store}=makeApi();
    const tampered=await createSnapshot(app,await currentRevision(app)).expect(201);
    store.debugMutateManifest(tampered.body.id,manifest=>{manifest.revision=42});
    const response=await request(app).get(`/api/snapshots/${tampered.body.id}`).expect(409);
    expect(response.body.error).toBe('manifest_tampered');

    const missing=await createSnapshot(app,await currentRevision(app)).expect(201);
    store.debugDeleteResource(missing.body.manifest.resources[0].digest);
    const gone=await request(app).get(`/api/snapshots/${missing.body.id}`).expect(409);
    expect(gone.body.error).toBe('resource_missing');
  });

  it('cleanup keeps resources still referenced by a live snapshot',async()=>{
    const {app,advance}=makeApi(1000);
    const shared=[{name:'shared.png',content:'SHARED'}];
    const first=await createSnapshot(app,await currentRevision(app),[...shared,{name:'only-first.txt',content:'F'}]).expect(201);
    advance(400);
    const second=await createSnapshot(app,await currentRevision(app),shared).expect(201);
    advance(601); // first expired, second still valid
    const cleanup=await request(app).post('/api/maintenance/cleanup').expect(200);
    expect(cleanup.body.removedSnapshots).toEqual([first.body.id]);
    const view=await request(app).get(`/api/snapshots/${second.body.id}`).expect(200);
    expect(view.body.resources[0]).toMatchObject({name:'shared.png',content:'SHARED'});
  });
});
