import {useState} from 'react';
import {Camera, Link2, Loader2} from 'lucide-react';
import type {ClientCapabilities, ResourceInput} from '../shared/types';

interface PickedResource {
  cid: string;
  contentType: string;
  contentBase64: string;
  size: number;
}

export default function SnapshotCreatePanel({
  templateId,
  revision,
  hasUnsavedDraft,
}: {
  templateId: string;
  revision: number;
  hasUnsavedDraft: boolean;
}) {
  const [capabilities, setCapabilities] = useState<ClientCapabilities>({
    viewportWidth: 800,
    images: true,
    css: true,
    imageTypes: ['image/png', 'image/jpeg', 'image/gif'],
    userAgent: 'email-rendering-lab/1.0',
  });
  const [resources, setResources] = useState<PickedResource[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<null | {shortLink: string; id: string}>(null);
  const [error, setError] = useState<string | null>(null);

  function toggleImageType(type: string, checked: boolean) {
    setCapabilities(previous => ({
      ...previous,
      imageTypes: checked
        ? [...previous.imageTypes.filter(value => value !== type), type]
        : previous.imageTypes.filter(value => value !== type),
    }));
  }

  async function pickFiles(files: FileList | null) {
    if (!files) return;
    const picked: PickedResource[] = [];
    for (const file of Array.from(files)) {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const baseName = file.name.replace(/\.[^.]+$/, '');
      picked.push({
        cid: baseName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-'),
        contentType: file.type || 'application/octet-stream',
        contentBase64,
        size: file.size,
      });
    }
    setResources(previous => [...previous, ...picked]);
  }

  function removeResource(index: number) {
    setResources(previous => previous.filter((_, i) => i !== index));
  }

  async function createSnapshot() {
    setBusy(true);
    setError(null);
    setResult(null);
    const payload = {
      templateId,
      revision,
      capabilities,
      resources: resources.map<ResourceInput>(resource => ({
        cid: resource.cid,
        contentType: resource.contentType,
        contentBase64: resource.contentBase64,
      })),
    };
    try {
      const response = await fetch('/api/snapshots', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.code === 'revision_conflict'
          ? '模板 revision 已变化，请重新加载后再生成快照。'
          : `快照生成失败：${body.message ?? body.error}`);
        return;
      }
      setResult({shortLink: body.shortLink, id: body.id});
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="snapshot-panel">
      <h2><Camera size={16}/>生成只读快照</h2>
      <p className="muted small">
        快照固定当前<strong>已保存的 revision {revision}</strong>、下列客户端能力与资源内容。
        {hasUnsavedDraft && <span className="warn-text"> 检测到未保存草稿：草稿不会进入快照，请先保存。</span>}
      </p>

      <fieldset className="cap-grid">
        <legend>客户端能力</legend>
        <label>
          <input
            type="checkbox"
            checked={capabilities.images}
            onChange={event => setCapabilities(p => ({...p, images: event.target.checked}))}
          />
          渲染内嵌图片
        </label>
        <label>
          <input
            type="checkbox"
            checked={capabilities.css}
            onChange={event => setCapabilities(p => ({...p, css: event.target.checked}))}
          />
          支持 CSS
        </label>
        <label className="viewport-field">
          视口宽度
          <input
            type="number"
            min={200}
            value={capabilities.viewportWidth}
            onChange={event => setCapabilities(p => ({...p, viewportWidth: Number(event.target.value)}))}
          />
        </label>
        <div className="type-toggles">
          <span>图片类型：</span>
          {['image/png', 'image/jpeg', 'image/gif', 'image/webp'].map(type => (
            <label key={type}>
              <input
                type="checkbox"
                checked={capabilities.imageTypes.includes(type)}
                onChange={event => toggleImageType(type, event.target.checked)}
              />
              {type.replace('image/', '')}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="resource-picker">
        <input
          type="file"
          multiple
          id="snapshot-resource-input"
          onChange={event => {
            void pickFiles(event.target.files);
            event.target.value = '';
          }}
        />
        {resources.length > 0 && (
          <ul className="picked-list">
            {resources.map((resource, index) => (
              <li key={index}>
                <code>cid:{resource.cid}</code>
                <span>{resource.contentType} · {resource.size} B</span>
                <button onClick={() => removeResource(index)}>移除</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button className="primary snapshot-create-btn" disabled={busy || hasUnsavedDraft} onClick={() => void createSnapshot()}>
        {busy ? <Loader2 size={15} className="spin"/> : <Camera size={15}/>}
        {busy ? '生成中…' : '固定并生成短链接'}
      </button>

      {error && <p className="error-text">{error}</p>}
      {result && (
        <p className="result-link">
          <Link2 size={14}/>
          快照已生成（内容相同资源自动去重）：
          <a href={'#/s/' + result.id}>{result.shortLink}</a>
        </p>
      )}
    </div>
  );
}
