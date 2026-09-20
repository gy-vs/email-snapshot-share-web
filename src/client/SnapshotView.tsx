import {useEffect,useState} from 'react';
import {AlertTriangle,ArrowLeft,Crosshair,Lock} from 'lucide-react';
import type {SnapshotView as SnapshotPayload} from '../shared/snapshot';

type State=
  |{phase:'loading'}
  |{phase:'error';code:string;message:string}
  |{phase:'ready';view:SnapshotPayload};

const ERROR_TEXT:Record<string,string>={
  not_found:'快照不存在或已被清理。',
  expired:'快照已过期，内容不再可用。',
  manifest_tampered:'清单签名校验失败：快照元数据被篡改，已拒绝展示。',
  resource_missing:'资源校验失败：快照引用的资源已缺失，已拒绝展示。',
  resource_tampered:'资源校验失败：资源内容与清单摘要不一致，已拒绝展示。',
};

export default function SnapshotView({id}:{id:string}){
  const [state,setState]=useState<State>({phase:'loading'});
  const [activePart,setActivePart]=useState<string|null>(null);
  useEffect(()=>{
    let alive=true;
    setState({phase:'loading'});
    fetch('/api/snapshots/'+id)
      .then(async response=>{const body=await response.json();if(!response.ok)throw{code:String(body.error??'unknown'),message:String(body.message??'')};return body as SnapshotPayload})
      .then(view=>{if(alive)setState({phase:'ready',view})})
      .catch((error:{code?:string;message?:string})=>{if(alive)setState({phase:'error',code:error.code??'network',message:error.message??'网络错误'})});
    return()=>{alive=false};
  },[id]);

  if(state.phase==='loading')return <main className="shell"><header className="topbar"><Lock size={20}/><strong>Snapshot</strong></header><section className="pane"><p>Loading snapshot {id}…</p></section></main>;
  if(state.phase==='error')return <main className="shell"><header className="topbar"><Lock size={20}/><strong>Snapshot</strong></header><section className="pane"><div className="error-box" role="alert"><AlertTriangle size={18}/><div><strong>{ERROR_TEXT[state.code]??'快照读取失败。'}</strong><br/><small>{state.code}{state.message?` — ${state.message}`:''}</small></div></div><p><a href="#/">返回编辑器</a></p></section></main>;

  const {view}=state;
  const {manifest}=view;
  const movedOn=view.currentRevision!==null&&view.currentRevision!==manifest.revision;
  const findings=manifest.analysis.degradations;
  return <main className="shell snap">
    <header className="topbar snap-topbar"><Lock size={20}/><strong>Read-only snapshot</strong><code>{view.id}</code><small>signature {view.signature.slice(0,12)}…</small><a className="back-link" href="#/"><ArrowLeft size={14}/>返回编辑器</a></header>
    <section className="snap-banner" role="note">
      <strong>只读快照</strong> — 固定于模板 <code>{manifest.templateId}</code> 的 revision {manifest.revision} · 客户端 {manifest.analysis.clientProfile.label} · 创建于 {new Date(manifest.createdAt).toLocaleString()} · 过期于 {new Date(manifest.expiresAt).toLocaleString()}
      {movedOn&&<div className="snap-moved"><AlertTriangle size={14}/> 模板草稿已更新到 revision {view.currentRevision}。此快照保持创建时内容，<strong>不是</strong>当前可编辑版本。</div>}
      {!movedOn&&view.currentRevision!==null&&<div>模板当前仍位于 revision {manifest.revision}；后续修改不会影响此快照。</div>}
    </section>
    <section className="workspace">
      <aside className="pane">
        <h2>MIME parts</h2>
        <div className="list">
          {manifest.analysis.mimeParts.map(part=>{
            const count=findings.filter(finding=>finding.partId===part.partId).length;
            return <button key={part.partId} className={'part-item'+(activePart===part.partId?' active':'')} onClick={()=>setActivePart(activePart===part.partId?null:part.partId)}>
              <span><strong>Part {part.partId}</strong> · {part.contentType}<br/><small>{part.name} · {part.size} B</small>{part.digest&&<><br/><small className="digest">{part.digest.slice(0,20)}…</small></>}</span>
              {count>0&&<span className="pill warn">{count} 项降级</span>}
            </button>;
          })}
        </div>
        <h2>Resources</h2>
        <div className="list">
          {view.resources.map(resource=><div className="resource-chip" key={resource.name}><code>{resource.name}</code><small className="digest">{resource.digest.slice(0,16)}…</small></div>)}
          {view.resources.length===0&&<p><small>无外部资源。</small></p>}
        </div>
      </aside>
      <section className="pane">
        <h2>Pinned content <span className="pill">read-only</span></h2>
        <pre className="readonly-content">{view.template.content}</pre>
        {activePart&&activePart!=='1'&&(()=>{const resource=view.resources[Number(activePart)-2];return resource?<div className="part-preview"><h3>Part {activePart} · {resource.name}</h3><pre className="readonly-content">{resource.content}</pre></div>:null})()}
      </section>
      <aside className="pane">
        <h2>降级解释</h2>
        {findings.length===0&&<p><small>在 {manifest.analysis.clientProfile.label} 的能力配置下没有检测到降级。</small></p>}
        <div className="list">
          {findings.map((finding,index)=>{
            const located=activePart===finding.partId;
            return <button key={index} className={'deg-item'+(located?' active':'')} onClick={()=>setActivePart(located?null:finding.partId)}>
              <span><strong>{finding.feature}</strong> — {finding.detail}</span>
              <span className="deg-explain">{finding.explanation}</span>
              <span className="deg-fallback">兜底：{finding.fallback}</span>
              <span className="deg-locate"><Crosshair size={13}/> 定位：MIME part {finding.partId}{finding.line!==null?` · 第 ${finding.line} 行`:''}</span>
            </button>;
          })}
        </div>
        <h2>Capabilities</h2>
        <div className="cap-grid">{Object.entries(manifest.analysis.clientProfile.capabilities).map(([key,value])=><span key={key} className={'pill'+(value?'':' off')}>{key}: {value?'✓':'✗'}</span>)}</div>
      </aside>
    </section>
  </main>;
}
