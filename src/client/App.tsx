import {useEffect,useState} from 'react';
import {Camera,FlaskConical,Play,Plus,Save,Trash2} from 'lucide-react';
import type {ClientProfile} from '../shared/snapshot';
import SnapshotView from './SnapshotView';
type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string};
type ResourceDraft={name:string;content:string};
type CreatedSnapshot={id:string;url:string;expiresAt:string};

function useHashRoute(){
  const [hash,setHash]=useState(window.location.hash);
  useEffect(()=>{const onChange=()=>setHash(window.location.hash);window.addEventListener('hashchange',onChange);return()=>window.removeEventListener('hashchange',onChange)},[]);
  return hash;
}

export default function App(){
  const hash=useHashRoute();
  const snapshotMatch=hash.match(/^#\/s\/([A-Za-z0-9_-]+)$/);
  if(snapshotMatch)return <SnapshotView id={snapshotMatch[1]}/>;
  return <Editor/>;
}

function Editor(){
  const [items,setItems]=useState<Summary[]>([]);const [selected,setSelected]=useState('alpha');const [row,setRow]=useState<Row|null>(null);const [draft,setDraft]=useState('');const [analysis,setAnalysis]=useState<unknown>(null);const [status,setStatus]=useState('Ready');
  const [profiles,setProfiles]=useState<ClientProfile[]>([]);const [profileId,setProfileId]=useState('');const [resources,setResources]=useState<ResourceDraft[]>([]);
  const [created,setCreated]=useState<CreatedSnapshot|null>(null);
  useEffect(()=>{fetch('/api/templates').then(r=>r.json()).then(setItems)},[]);
  useEffect(()=>{fetch('/api/client-profiles').then(r=>r.json()).then((list:ClientProfile[])=>{setProfiles(list);setProfileId(list[0]?.id??'')})},[]);
  useEffect(()=>{setStatus('Loading');setCreated(null);fetch('/api/templates/'+selected).then(r=>r.json()).then((value:Row)=>{setRow(value);setDraft(value.content);setStatus('Loaded')})},[selected]);
  async function save(){if(!row)return;setStatus('Saving');const response=await fetch('/api/templates/'+row.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,revision:row.revision})});const value=await response.json();if(!response.ok){setStatus('Revision conflict');return}setRow(value);setStatus('Saved')}
  async function analyze(){if(!row)return;setStatus('Analyzing');const response=await fetch('/api/templates/'+row.id+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft})});setAnalysis(await response.json());setStatus('Ready')}
  async function snapshot(){if(!row)return;setStatus('Snapshotting');const response=await fetch('/api/snapshots',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({templateId:row.id,revision:row.revision,clientProfileId:profileId,resources:resources.filter(resource=>resource.name.trim()!=='')})});const value=await response.json();if(!response.ok){setStatus('Snapshot failed: '+(value.error??response.status));return}setCreated({id:value.id,url:value.url,expiresAt:value.manifest.expiresAt});setStatus('Snapshot created')}
  function updateResource(index:number,patch:Partial<ResourceDraft>){setResources(current=>current.map((resource,i)=>i===index?{...resource,...patch}:resource))}
  return <main className="shell"><header className="topbar"><FlaskConical size={20}/><strong>Email Rendering Lab</strong><small>Local workspace</small></header><section className="workspace"><aside className="pane"><h2>Items</h2><div className="list">{items.map(item=><button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>{item.name}<br/><small>Revision {item.revision}</small></button>)}</div>
    <h2>Resources</h2><div className="list">{resources.map((resource,index)=><div className="resource-row" key={index}><input aria-label="Resource name" placeholder="hero.webp" value={resource.name} onChange={event=>updateResource(index,{name:event.target.value})}/><input aria-label="Resource content" placeholder="content" value={resource.content} onChange={event=>updateResource(index,{content:event.target.value})}/><button title="Remove resource" onClick={()=>setResources(current=>current.filter((_,i)=>i!==index))}><Trash2 size={14}/></button></div>)}</div>
    <div className="toolbar"><button onClick={()=>setResources(current=>[...current,{name:'',content:''}])}><Plus size={15}/>Add resource</button></div>
  </aside><section className="pane"><div className="toolbar"><button className="primary" onClick={save}><Save size={15}/>Save</button><button onClick={analyze}><Play size={15}/>Analyze</button><select aria-label="Client profile" value={profileId} onChange={event=>setProfileId(event.target.value)}>{profiles.map(profile=><option value={profile.id} key={profile.id}>{profile.label}</option>)}</select><button onClick={snapshot}><Camera size={15}/>Create snapshot</button><span>{status}</span></div>
    {created&&<div className="snapshot-link">Read-only snapshot <code>{created.id}</code> (expires {new Date(created.expiresAt).toLocaleString()}) — local short link: <a href={created.url}>{created.url}</a></div>}
    <textarea aria-label="Content" value={draft} onChange={event=>setDraft(event.target.value)}/></section><aside className="pane"><h2>Inspection</h2><span className="pill">{selected}</span><pre>{JSON.stringify(analysis??row,null,2)}</pre></aside></section></main>;
}
