import {useCallback, useEffect, useState, type ReactNode} from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Copy,
  FileLock2,
  Hourglass,
  Info,
  Link2,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import type {SnapshotView} from '../shared/types';

type LoadState =
  | {kind: 'loading'}
  | {kind: 'ready'; view: SnapshotView}
  | {kind: 'error'; status: number; code: string; message: string};

function shortDigest(digest: string): string {
  return digest.slice(0, 12) + '…';
}

function decodeBase64Text(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export default function SnapshotReader({id}: {id: string}) {
  const [state, setState] = useState<LoadState>({kind: 'loading'});
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({kind: 'loading'});
    fetch('/api/snapshots/' + encodeURIComponent(id))
      .then(async response => {
        const body = await response.json();
        if (cancelled) return;
        if (response.ok) {
          setState({kind: 'ready', view: body as SnapshotView});
        } else {
          setState({kind: 'error', status: response.status, code: body.error ?? 'error', message: body.message ?? 'read failed'});
        }
      })
      .catch(error => {
        if (!cancelled) setState({kind: 'error', status: 0, code: 'network', message: String(error)});
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const copyLink = useCallback(() => {
    const url = window.location.origin + window.location.pathname + '#/s/' + id;
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [id]);

  if (state.kind === 'loading') {
    return <main className="shell"><ReaderShell id={id}><p className="muted">正在校验快照签名与资源摘要…</p></ReaderShell></main>;
  }

  if (state.kind === 'error') {
    const expired = state.code === 'snapshot_expired';
    const tampered = state.code === 'manifest_tampered' || state.code === 'resource_integrity_failed';
    return (
      <main className="shell">
        <ReaderShell id={id}>
          <div className={'error-card ' + (expired ? 'expired' : tampered ? 'tampered' : 'missing')}>
            {expired ? <Hourglass size={28}/> : tampered ? <ShieldAlert size={28}/> : <AlertTriangle size={28}/>}
            <h2>{expired ? '快照已过期' : tampered ? '快照完整性校验失败' : '快照不存在'}</h2>
            <p>
              {expired
                ? '该只读快照超过了保留期限，已无法打开。请从当前 revision 重新生成快照。'
                : tampered
                  ? `服务器拒绝读取：${state.message} 清单或资源内容与固定签名不一致。`
                  : `无法找到该快照（${state.code}）。短链接可能已被清理任务移除。`}
            </p>
            <a className="button" href="#/">
              <ArrowLeft size={15}/>返回工作台
            </a>
          </div>
        </ReaderShell>
      </main>
    );
  }

  const {view} = state;
  return (
    <main className="shell">
      <ReaderShell id={id} onCopy={copyLink} copied={copied}>
        <div className="readonly-banner">
          <FileLock2 size={18}/>
          <div>
            <strong>只读预览快照</strong>
            <span>
              固定 {view.templateName} · revision {view.templateRevision} · 创建于 {new Date(view.createdAt).toLocaleString()} ·
              有效至 {new Date(view.expiresAt).toLocaleString()}
            </span>
          </div>
          <ShieldCheck size={18} className="ok-icon"/>
        </div>

        {view.stale && (
          <div className="notice warn">
            <Info size={16}/>
            <span>
              模板此后已更新到 revision {view.currentTemplateRevision}。当前页面仍展示快照固定的 revision{' '}
              {view.templateRevision}，不会反映草稿或新 revision 的内容。
            </span>
          </div>
        )}

        <section className="reader-grid">
          <div className="pane">
            <h2>固定模板内容</h2>
            <span className="pill">sha256 {shortDigest(view.templateDigest)}</span>
            <textarea aria-label="Pinned template content" readOnly value={view.templateContent}/>
            <p className="muted small">
              内容为快照生成时 revision {view.templateRevision} 的字节副本，编辑器中的草稿与后续保存均不影响此页面。
            </p>
          </div>

          <div className="pane">
            <h2>降级解释</h2>
            {view.degradation.length === 0 ? (
              <p className="muted">该客户端能力配置下无需降级。</p>
            ) : (
              <ul className="degradation-list">
                {view.degradation.map((note, index) => (
                  <li key={index}>
                    <span className={'deg-code ' + note.code}>{note.code}</span>
                    <span>{note.message}</span>
                  </li>
                ))}
              </ul>
            )}

            <h2>MIME part 定位</h2>
            <table className="mime-table">
              <thead>
                <tr><th>路径</th><th>Content-Type</th><th>CID</th><th>摘要</th><th>字节</th></tr>
              </thead>
              <tbody>
                {view.mimeParts.map(part => (
                  <tr key={part.path}>
                    <td><code>{part.path}</code></td>
                    <td>{part.contentType}</td>
                    <td>{part.cid ? <code>cid:{part.cid}</code> : <span className="muted">—</span>}</td>
                    <td><code title={part.digest}>{part.digest ? shortDigest(part.digest) : '—'}</code></td>
                    <td>{part.bytes}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h2>资源预览（{view.resources.length}）</h2>
            {view.resources.length === 0 && <p className="muted">此快照不包含关联资源。</p>}
            <div className="resource-grid">
              {view.resources.map(resource => (
                <figure className="resource-card" key={resource.digest}>
                  {resource.contentType.startsWith('image/') ? (
                    <img
                      alt={resource.cid ?? resource.contentType}
                      src={`data:${resource.contentType};base64,${resource.contentBase64}`}
                    />
                  ) : resource.contentType.startsWith('text/') ? (
                    <pre className="resource-text">{decodeBase64Text(resource.contentBase64)}</pre>
                  ) : (
                    <span className="muted binary-hint">二进制资源 · {resource.bytes} 字节</span>
                  )}
                  <figcaption>
                    {resource.cid ? <code>cid:{resource.cid}</code> : resource.contentType}
                    <code title={resource.digest}>{shortDigest(resource.digest)}</code>
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>

          <div className="pane">
            <h2>固定客户端能力</h2>
            <pre>{JSON.stringify(view.capabilities, null, 2)}</pre>
            <h2>整体签名</h2>
            <span className="pill sig" title={view.signature}>HMAC {shortDigest(view.signature)}</span>
            <p className="muted small">读取时逐项重算模板与资源 SHA-256，并校验清单 HMAC；任何篡改都会被拒绝。</p>
          </div>
        </section>
      </ReaderShell>
    </main>
  );
}

function ReaderShell({
  id,
  children,
  onCopy,
  copied,
}: {
  id: string;
  children: ReactNode;
  onCopy?: () => void;
  copied?: boolean;
}) {
  return (
    <>
      <header className="topbar snapshot-topbar">
        <FileLock2 size={20}/>
        <strong>只读快照</strong>
        <small className="short-link">
          <Link2 size={13}/> #/s/{id}
        </small>
        <span className="topbar-spacer"/>
        {onCopy && (
          <button className="topbar-btn" onClick={onCopy}>
            <Copy size={14}/>{copied ? '已复制' : '复制短链接'}
          </button>
        )}
        <a className="topbar-btn" href="#/">
          <ArrowLeft size={14}/>返回可编辑工作台
        </a>
      </header>
      <div className="reader-body">{children}</div>
    </>
  );
}
