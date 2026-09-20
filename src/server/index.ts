import express from 'express';
import {fileURLToPath} from 'node:url';
import {CLIENT_PROFILES, SnapshotError, SnapshotStore} from './snapshots';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
function seedRows(): RecordRow[] {
  return [
    {id:'alpha',name:'Primary render previews',revision:3,content:'<html><body style="border-radius:8px"><h1>render previews: alpha</h1><img src="cid:hero.webp"/><p>state: active</p></body></html>',updatedAt:new Date(0).toISOString()},
    {id:'beta',name:'Secondary render previews',revision:5,content:'<html><body><h1>render previews: beta</h1><p>state: review</p></body></html>',updatedAt:new Date(1000).toISOString()},
  ];
}

export function createApp(options:{store?:SnapshotStore}={}){
  const rows=seedRows();
  const store=options.store??new SnapshotStore();
  const app=express();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"email-rendering",count:rows.length}));
  app.get('/api/templates',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/templates/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/templates/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/templates/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});

  app.get('/api/client-profiles',(_req,res)=>res.json(CLIENT_PROFILES));

  // Create a read-only snapshot pinned to the template's current revision.
  app.post('/api/snapshots',async(req,res)=>{
    const {templateId,revision,clientProfileId,resources}=req.body??{};
    const row=rows.find(value=>value.id===templateId);
    if(!row)throw new SnapshotError('template_not_found','unknown template',404);
    if(revision!==row.revision)throw new SnapshotError('revision_conflict',`template ${row.id} is at revision ${row.revision}`,409);
    const result=await store.createSnapshot({templateId:row.id,revision:row.revision,templateContent:row.content,clientProfileId:String(clientProfileId??''),resources:resources??[]});
    res.status(201).json({id:result.id,url:`/#/s/${result.id}`,manifest:result.manifest,signature:result.signature});
  });

  // Read a snapshot. Every resource is digest-verified before anything is returned.
  app.get('/api/snapshots/:id',async(req,res)=>{
    const view=await store.readSnapshot(req.params.id);
    const row=rows.find(value=>value.id===view.manifest.templateId);
    res.set('Cache-Control','no-store').json({...view,currentRevision:row?row.revision:null});
  });

  // Local maintenance: drop expired snapshots and unreferenced resources.
  app.post('/api/maintenance/cleanup',async(_req,res)=>{res.json(await store.cleanup())});

  app.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    if(err instanceof SnapshotError)return res.status(err.status).json({error:err.code,message:err.message});
    console.error(err);
    res.status(500).json({error:'internal'});
  });
  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
