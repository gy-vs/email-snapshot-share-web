import {useEffect,useState} from 'react';
import {FlaskConical,Play,Save} from 'lucide-react';
import SnapshotReader from './SnapshotReader';
import SnapshotCreatePanel from './SnapshotCreatePanel';

type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string};

function useHashRoute(){
  const [hash,setHash]=useState(()=>window.location.hash);
  useEffect(()=>{
    const onChange=()=>setHash(window.location.hash);
    window.addEventListener('hashchange',onChange);
    return ()=>window.removeEventListener('hashchange',onChange);
  },[]);
  return hash;
}

// #/s/:id -> read-only snapshot; anything else -> the editable workbench.
function parseSnapshotRoute(hash:string):string|null{
  const match=/^#\/s\/([A-Za-z0-9_-]+)/.exec(hash);
  return match?match[1]:null;
}

function Workbench(){
  const [items,setItems]=useState<Summary[]>([]);const [selected,setSelected]=useState('alpha');const [row,setRow]=useState<Row|null>(null);const [draft,setDraft]=useState('');const [analysis,setAnalysis]=useState<unknown>(null);const [status,setStatus]=useState('Ready');
  useEffect(()=>{fetch('/api/templates').then(r=>r.json()).then(setItems)},[]);
  useEffect(()=>{setStatus('Loading');fetch('/api/templates/'+selected).then(r=>r.json()).then((value:Row)=>{setRow(value);setDraft(value.content);setStatus('Loaded')})},[selected]);
  async function save(){if(!row)return;setStatus('Saving');const response=await fetch('/api/templates/'+row.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,revision:row.revision})});const value=await response.json();if(!response.ok){setStatus('Revision conflict');return}setRow(value);setStatus('Saved')}
  async function analyze(){if(!row)return;setStatus('Analyzing');const response=await fetch('/api/templates/'+row.id+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft})});setAnalysis(await response.json());setStatus('Ready')}
  const dirty=row!==null&&draft!==row.content;
  return <main className="shell"><header className="topbar"><FlaskConical size={20}/><strong>Email Rendering Lab</strong><small>Local workspace</small></header><section className="workspace"><aside className="pane"><h2>Items</h2><div className="list">{items.map(item=><button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>{item.name}<br/><small>Revision {item.revision}</small></button>)}</div></aside><section className="pane"><div className="toolbar"><button className="primary" onClick={save}><Save size={15}/>Save</button><button onClick={analyze}><Play size={15}/>Analyze</button><span>{status}{dirty?' · 未保存草稿':''}</span></div><textarea aria-label="Content" value={draft} onChange={event=>setDraft(event.target.value)}/></section><aside className="pane"><h2>Inspection</h2><span className="pill">{selected}</span><pre>{JSON.stringify(analysis??row,null,2)}</pre>{row&&<SnapshotCreatePanel templateId={row.id} revision={row.revision} hasUnsavedDraft={dirty}/>}</aside></section></main>;
}

export default function App(){
  const hash=useHashRoute();
  const snapshotId=parseSnapshotRoute(hash);
  if(snapshotId)return <SnapshotReader id={snapshotId}/>;
  return <Workbench/>;
}
