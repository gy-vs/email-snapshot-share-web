import express from 'express';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import type {CreateSnapshotRequest, ResourceInput} from '../shared/types';
import {SnapshotError, SnapshotStore, type SnapshotStoreOptions, type TemplateInfo} from './snapshotStore';

type RecordRow = TemplateInfo & {updatedAt: string};

const seedRows = (): RecordRow[] => [
  {id:'alpha',name:'Primary render previews',revision:3,content:'render previews: alpha\nstate: active',contentType:'text/plain',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary render previews',revision:5,content:'render previews: beta\nstate: review',contentType:'text/plain',updatedAt:new Date(1000).toISOString()},
];

export interface AppOptions {
  snapshot?: SnapshotStoreOptions;
  // Periodic cleanup in the standalone process. Disabled under tests.
  cleanupIntervalMs?: number;
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  // Each app gets its own mutable tables so requests in one test can't leak
  // state into the next.
  const rows = seedRows();
  const store = new SnapshotStore(id => rows.find(row => row.id === id), options.snapshot);
  app.locals.snapshotStore = store;

  app.use(express.json({limit:'2mb'}));

  app.get('/api/bootstrap',(_req,res)=>res.json({family:"email-rendering",count:rows.length}));
  app.get('/api/templates',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/templates/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/templates/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/templates/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});

  // --- Read-only preview snapshots -----------------------------------------

  app.post('/api/resources',(req,res,next)=>{
    try {
      const saved = store.putResource(req.body as ResourceInput);
      res.json(saved);
    } catch (error) { next(error); }
  });

  app.post('/api/snapshots',(req,res,next)=>{
    try {
      const manifest = store.create(req.body as CreateSnapshotRequest);
      // Local-only short link: no host, storage, or external service involved.
      res.status(201).json({id: manifest.id, shortLink: `#/s/${manifest.id}`, manifest});
    } catch (error) { next(error); }
  });

  app.get('/api/snapshots',(_req,res)=>res.json({snapshots: store.list()}));

  app.get('/api/snapshots/:id',(async(req,res,next)=>{
    try {
      res.json(await store.read(req.params.id));
    } catch (error) { next(error); }
  }));

  app.delete('/api/resources/:digest',(async(req,res,next)=>{
    try {
      await store.deleteResource(req.params.digest);
      res.status(204).end();
    } catch (error) { next(error); }
  }));

  // Local maintenance hook; only reachable through the loopback server.
  app.post('/api/snapshots/cleanup',(async(_req,res,next)=>{
    try { res.json(await store.cleanup()); } catch (error) { next(error); }
  }));

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof SnapshotError) {
      res.status(error.status).json({error: error.code, message: error.message});
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({error: 'invalid_json', message: 'request body is not valid JSON'});
      return;
    }
    res.status(500).json({error: 'internal_error'});
  });

  // In production the same Express process serves the built client; API routes
  // above take precedence so short links on any path keep working client-side.
  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
    app.use(express.static(distDir));
    app.get(/.*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
  }

  if (options.cleanupIntervalMs) {
    const timer = setInterval(() => void store.cleanup(), options.cleanupIntervalMs);
    timer.unref();
  }

  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  createApp({cleanupIntervalMs: 15 * 60 * 1000}).listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'));
}
