import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import type {
  ClientProfile,
  Degradation,
  ManifestResource,
  MimePart,
  RenderAnalysis,
  SnapshotErrorCode,
  SnapshotManifest,
  SnapshotView,
} from '../shared/snapshot';

export class SnapshotError extends Error {
  constructor(
    public readonly code: SnapshotErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export const CLIENT_PROFILES: ClientProfile[] = [
  {id: 'gmail-web', label: 'Gmail Web', capabilities: {mediaQueries: true, cssGrid: false, webp: true, video: false, borderRadius: true, positionFixed: false}},
  {id: 'outlook-desktop', label: 'Outlook Desktop', capabilities: {mediaQueries: false, cssGrid: false, webp: false, video: false, borderRadius: false, positionFixed: false}},
  {id: 'apple-mail', label: 'Apple Mail', capabilities: {mediaQueries: true, cssGrid: true, webp: true, video: true, borderRadius: true, positionFixed: true}},
];

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RESOURCES = 32;
const MAX_RESOURCE_BYTES = 256 * 1024;
const RESOURCE_NAME_PATTERN = /^[\w][\w.\-]{0,63}$/;

export function digestOf(content: string): string {
  return 'sha256:' + createHash('sha256').update(content, 'utf8').digest('base64url');
}

/** Stable JSON with recursively sorted keys, so signatures are deterministic. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key]);
    return out;
  }
  return value;
}

/**
 * Fair readers/writer lock. Snapshot reads hold a shared lock across the whole
 * assembly; cleanup takes the exclusive lock, so a read that started while the
 * snapshot was valid always observes a complete, consistent resource set —
 * never half a page.
 */
export class RwLock {
  private readers = 0;
  private writerActive = false;
  private readonly queue: {writer: boolean; run: () => void}[] = [];

  acquireRead(): Promise<() => void> {
    return new Promise(resolve => {
      this.queue.push({writer: false, run: () => resolve(() => {
        this.readers -= 1;
        this.pump();
      })});
      this.pump();
    });
  }

  acquireWrite(): Promise<() => void> {
    return new Promise(resolve => {
      this.queue.push({writer: true, run: () => resolve(() => {
        this.writerActive = false;
        this.pump();
      })});
      this.pump();
    });
  }

  private pump(): void {
    while (!this.writerActive && this.queue.length > 0) {
      const head = this.queue[0];
      if (head.writer) {
        if (this.readers > 0) return;
        this.queue.shift();
        this.writerActive = true;
        head.run();
        return;
      }
      this.queue.shift();
      this.readers += 1;
      head.run();
    }
  }
}

type FeatureRule = {
  feature: string;
  capability: string;
  pattern: RegExp;
  detail: string;
  fallback: string;
  explanation: string;
};

const HTML_FEATURE_RULES: FeatureRule[] = [
  {feature: 'media-queries', capability: 'mediaQueries', pattern: /@media\b/i, detail: '模板使用了 @media 响应式规则', fallback: '回退为固定宽度布局', explanation: '该客户端会忽略媒体查询，响应式样式不会生效。'},
  {feature: 'css-grid', capability: 'cssGrid', pattern: /display\s*:\s*grid/i, detail: '模板使用了 display: grid 布局', fallback: '回退为表格（table）布局', explanation: '该客户端不支持 CSS Grid，网格区域会塌陷。'},
  {feature: 'position-fixed', capability: 'positionFixed', pattern: /position\s*:\s*fixed/i, detail: '模板使用了 position: fixed 定位', fallback: '元素改为随文档流滚动', explanation: '该客户端不支持固定定位，元素将停留在文档流中的原始位置。'},
  {feature: 'border-radius', capability: 'borderRadius', pattern: /border-radius/i, detail: '模板使用了 border-radius 圆角', fallback: '以直角渲染', explanation: '该客户端忽略圆角声明，卡片与按钮会显示为直角。'},
  {feature: 'html5-video', capability: 'video', pattern: /<video\b/i, detail: '模板嵌入了 <video> 标签', fallback: '替换为静态封面图与播放链接', explanation: '该客户端不渲染 HTML5 视频，需要封面图兜底。'},
];

function guessContentType(name: string): string {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    case 'css': return 'text/css';
    case 'txt': return 'text/plain';
    default: return 'application/octet-stream';
  }
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (content.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * Deterministic render analysis for the lab: which MIME parts the message
 * consists of, and which template features degrade under the pinned client
 * capability config. Computed once at snapshot time and stored inside the
 * signed manifest.
 */
export function analyzeRender(
  templateContent: string,
  templateDigest: string,
  resources: ManifestResource[],
  profile: ClientProfile,
): RenderAnalysis {
  const mimeParts: MimePart[] = [
    {partId: '1', contentType: 'text/html', name: 'message.html', size: Buffer.byteLength(templateContent, 'utf8'), digest: templateDigest},
    ...resources.map((resource, index) => ({
      partId: String(index + 2),
      contentType: guessContentType(resource.name),
      name: resource.name,
      size: resource.size,
      digest: resource.digest,
    })),
  ];

  const degradations: Degradation[] = [];
  for (const rule of HTML_FEATURE_RULES) {
    if (profile.capabilities[rule.capability]) continue;
    const match = rule.pattern.exec(templateContent);
    if (!match) continue;
    degradations.push({
      feature: rule.feature,
      partId: '1',
      line: lineOf(templateContent, match.index),
      detail: rule.detail,
      fallback: rule.fallback,
      explanation: rule.explanation,
    });
  }
  resources.forEach((resource, index) => {
    if (profile.capabilities.webp) return;
    if (!resource.name.toLowerCase().endsWith('.webp')) return;
    degradations.push({
      feature: 'webp-image',
      partId: String(index + 2),
      line: null,
      detail: `资源 ${resource.name} 是 WebP 图像`,
      fallback: '替换为 PNG 回退图',
      explanation: '该客户端无法解码 WebP，需要回退格式否则显示为破图。',
    });
  });

  return {clientProfile: profile, mimeParts, degradations};
}

type StoredSnapshot = {manifest: SnapshotManifest; signature: string};

export type CreateSnapshotInput = {
  templateId: string;
  revision: number;
  templateContent: string;
  clientProfileId: string;
  resources: {name: string; content: string}[];
};

export type CreateSnapshotResult = {
  id: string;
  manifest: SnapshotManifest;
  signature: string;
};

export class SnapshotStore {
  private readonly resources = new Map<string, string>();
  private readonly snapshots = new Map<string, StoredSnapshot>();
  private readonly lock = new RwLock();
  private readonly secret: string;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: {secret?: string; ttlMs?: number; now?: () => number} = {}) {
    this.secret = options.secret ?? randomBytes(32).toString('hex');
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async createSnapshot(input: CreateSnapshotInput): Promise<CreateSnapshotResult> {
    const release = await this.lock.acquireWrite();
    try {
      const profile = CLIENT_PROFILES.find(candidate => candidate.id === input.clientProfileId);
      if (!profile) throw new SnapshotError('unknown_client_profile', `unknown client profile: ${String(input.clientProfileId)}`, 400);
      const resources = validateResources(input.resources);

      const createdAt = new Date(this.now());
      const templateDigest = this.putResource(input.templateContent);
      const manifestResources: ManifestResource[] = resources.map(resource => ({
        name: resource.name,
        digest: this.putResource(resource.content),
        size: Buffer.byteLength(resource.content, 'utf8'),
      }));
      // Pin the full capability config, not just the profile id.
      const pinnedProfile: ClientProfile = {id: profile.id, label: profile.label, capabilities: {...profile.capabilities}};
      const manifest: SnapshotManifest = {
        version: 1,
        templateId: input.templateId,
        revision: input.revision,
        template: {digest: templateDigest, size: Buffer.byteLength(input.templateContent, 'utf8')},
        clientProfile: pinnedProfile,
        resources: manifestResources,
        analysis: analyzeRender(input.templateContent, templateDigest, manifestResources, pinnedProfile),
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + this.ttlMs).toISOString(),
      };
      const signature = this.signManifest(manifest);
      const id = this.newId();
      this.snapshots.set(id, {manifest, signature});
      return {id, manifest, signature};
    } finally {
      release();
    }
  }

  /**
   * Assemble a snapshot for reading. Every manifest entry is verified against
   * the signature, and every resource is re-hashed against its manifest digest
   * before content is returned. Any mismatch rejects the whole read — the
   * caller never receives a partially assembled page.
   */
  async readSnapshot(id: string): Promise<Omit<SnapshotView, 'currentRevision'>> {
    const release = await this.lock.acquireRead();
    try {
      const stored = this.snapshots.get(id);
      if (!stored) throw new SnapshotError('not_found', `unknown snapshot: ${id}`, 404);
      if (Date.parse(stored.manifest.expiresAt) <= this.now()) {
        throw new SnapshotError('expired', `snapshot ${id} expired at ${stored.manifest.expiresAt}`, 410);
      }
      this.verifyManifest(stored);
      const template = await this.loadResource(stored.manifest.template.digest);
      const resources: {name: string; digest: string; size: number; content: string}[] = [];
      for (const entry of stored.manifest.resources) {
        resources.push({...entry, content: await this.loadResource(entry.digest)});
      }
      return {
        id,
        manifest: stored.manifest,
        signature: stored.signature,
        template: {...stored.manifest.template, content: template},
        resources,
      };
    } finally {
      release();
    }
  }

  /**
   * Remove expired snapshots, then delete only resources that no remaining
   * snapshot references. Reference collection is conservative: digests are
   * collected from every stored manifest without requiring a valid signature,
   * so a tampered manifest can never cause its claimed resources to be kept
   * at the expense of another snapshot's.
   */
  async cleanup(): Promise<{removedSnapshots: string[]; removedResources: string[]}> {
    const release = await this.lock.acquireWrite();
    try {
      const now = this.now();
      const removedSnapshots: string[] = [];
      for (const [id, stored] of this.snapshots) {
        if (Date.parse(stored.manifest.expiresAt) <= now) {
          this.snapshots.delete(id);
          removedSnapshots.push(id);
        }
      }
      const referenced = new Set<string>();
      for (const stored of this.snapshots.values()) {
        referenced.add(stored.manifest.template.digest);
        for (const resource of stored.manifest.resources) referenced.add(resource.digest);
      }
      const removedResources: string[] = [];
      for (const digest of [...this.resources.keys()]) {
        if (!referenced.has(digest)) {
          this.resources.delete(digest);
          removedResources.push(digest);
        }
      }
      return {removedSnapshots, removedResources};
    } finally {
      release();
    }
  }

  private putResource(content: string): string {
    const digest = digestOf(content);
    // Content-addressed dedup: identical bytes are stored exactly once.
    if (!this.resources.has(digest)) this.resources.set(digest, content);
    return digest;
  }

  private async loadResource(digest: string): Promise<string> {
    const content = this.resources.get(digest);
    if (content === undefined) throw new SnapshotError('resource_missing', `resource ${digest} is missing from the store`, 409);
    if (digestOf(content) !== digest) throw new SnapshotError('resource_tampered', `resource ${digest} failed digest verification`, 409);
    return content;
  }

  private signManifest(manifest: SnapshotManifest): string {
    return createHmac('sha256', this.secret).update(canonicalJson(manifest), 'utf8').digest('base64url');
  }

  private verifyManifest(stored: StoredSnapshot): void {
    const expected = Buffer.from(this.signManifest(stored.manifest), 'utf8');
    const actual = Buffer.from(stored.signature, 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new SnapshotError('manifest_tampered', 'snapshot manifest signature mismatch', 409);
    }
  }

  private newId(): string {
    let id = randomBytes(6).toString('base64url');
    while (this.snapshots.has(id)) id = randomBytes(6).toString('base64url');
    return id;
  }

  // --- Introspection and fault-injection hooks, used by the test suite. ---

  debugResourceCount(): number {
    return this.resources.size;
  }

  debugHasResource(digest: string): boolean {
    return this.resources.has(digest);
  }

  debugSnapshotIds(): string[] {
    return [...this.snapshots.keys()];
  }

  debugDeleteResource(digest: string): void {
    this.resources.delete(digest);
  }

  debugReplaceResource(digest: string, content: string): void {
    this.resources.set(digest, content);
  }

  debugMutateManifest(id: string, mutate: (manifest: SnapshotManifest) => void): void {
    const stored = this.snapshots.get(id);
    if (!stored) throw new Error(`no such snapshot: ${id}`);
    mutate(stored.manifest);
  }
}

function validateResources(input: {name: string; content: string}[]): {name: string; content: string}[] {
  if (!Array.isArray(input)) throw new SnapshotError('invalid_resource', 'resources must be an array', 400);
  if (input.length > MAX_RESOURCES) throw new SnapshotError('invalid_resource', `too many resources (max ${MAX_RESOURCES})`, 400);
  const seen = new Set<string>();
  return input.map(raw => {
    const name = String(raw?.name ?? '');
    const content = String(raw?.content ?? '');
    if (!RESOURCE_NAME_PATTERN.test(name)) throw new SnapshotError('invalid_resource', `invalid resource name: ${name || '(empty)'}`, 400);
    if (seen.has(name)) throw new SnapshotError('invalid_resource', `duplicate resource name: ${name}`, 400);
    if (Buffer.byteLength(content, 'utf8') > MAX_RESOURCE_BYTES) throw new SnapshotError('invalid_resource', `resource too large: ${name}`, 400);
    seen.add(name);
    return {name, content};
  });
}
