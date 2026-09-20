import {Buffer} from 'node:buffer';
import {timingSafeEqual} from 'node:crypto';
import type {
  ClientCapabilities,
  CreateSnapshotRequest,
  DegradationNote,
  MimePart,
  ResourceInput,
  SnapshotManifest,
  SnapshotView,
} from '../shared/types';
import {canonicalJson, hmac, randomSecret, sha256, shortId} from './integrity';

export interface TemplateInfo {
  id: string;
  name: string;
  revision: number;
  content: string;
  contentType?: string;
}

export class SnapshotError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// FIFO readers/writer lock. Readers batch behind a queued writer so cleanup
// (the writer) can never be starved, and a read that holds the lock observes a
// stable blob/manifest set for its whole duration (no half-rendered pages).
class RwLock {
  private readers = 0;
  private writer = false;
  private waiters: Array<{kind: 'read' | 'write'; resolve: () => void}> = [];

  private pump() {
    if (this.writer || this.readers > 0) return;
    const first = this.waiters[0];
    if (!first) return;
    if (first.kind === 'write') {
      this.writer = true;
      this.waiters.shift()!.resolve();
    } else {
      while (this.waiters[0]?.kind === 'read') {
        this.readers += 1;
        this.waiters.shift()!.resolve();
      }
    }
  }

  async acquireRead() {
    if (!this.writer && this.waiters.length === 0) {
      this.readers += 1;
      return;
    }
    await new Promise<void>(resolve => this.waiters.push({kind: 'read', resolve}));
  }

  async acquireWrite() {
    if (!this.writer && this.readers === 0 && this.waiters.length === 0) {
      this.writer = true;
      return;
    }
    await new Promise<void>(resolve => this.waiters.push({kind: 'write', resolve}));
  }

  releaseRead() {
    this.readers -= 1;
    this.pump();
  }

  releaseWrite() {
    this.writer = false;
    this.pump();
  }
}

export interface SnapshotStoreOptions {
  ttlMs?: number;
  now?: () => number;
  secret?: string;
  // Called (and awaited) right after a read acquires its lock, before any
  // verification. Lets callers prove cleanup cannot interleave with a read.
  onReadAcquired?: () => void | Promise<void>;
}

interface StoredResource {
  cid: string | null;
  contentType: string;
  digest: string;
  bytes: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const LARGE_RESOURCE_BYTES = 512 * 1024;

const DEFAULT_CAPABILITIES: ClientCapabilities = {
  viewportWidth: 800,
  images: true,
  css: true,
  imageTypes: ['image/png', 'image/jpeg', 'image/gif'],
  userAgent: 'email-rendering-lab/1.0',
};

export class SnapshotStore {
  // Content-addressed blob pool, shared by every snapshot. One entry per digest.
  readonly blobs = new Map<string, Uint8Array>();
  readonly manifests = new Map<string, SnapshotManifest>();
  private readonly lock = new RwLock();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly secret: string;
  private readonly onReadAcquired?: () => void | Promise<void>;

  constructor(
    private readonly lookupTemplate: (id: string) => TemplateInfo | undefined,
    options: SnapshotStoreOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.secret = options.secret ?? randomSecret();
    this.onReadAcquired = options.onReadAcquired;
  }

  // Decode one uploaded resource and intern it in the blob pool.
  // Identical content always maps to the same digest (deduplication), even
  // across snapshots or different CIDs.
  putResource(input: ResourceInput): StoredResource {
    if (!input || typeof input.contentType !== 'string' || !input.contentType) {
      throw new SnapshotError(400, 'invalid_resource', 'resource requires a contentType');
    }
    let bytes: Uint8Array;
    if (input.contentBase64 != null) {
      const decoded = Buffer.from(String(input.contentBase64), 'base64');
      if (!isValidBase64(String(input.contentBase64), decoded)) {
        throw new SnapshotError(400, 'invalid_resource', 'contentBase64 is not valid base64');
      }
      bytes = decoded;
    } else if (input.contentText != null) {
      bytes = Buffer.from(String(input.contentText), 'utf8');
    } else {
      throw new SnapshotError(400, 'invalid_resource', 'resource requires contentBase64 or contentText');
    }
    const digest = sha256(bytes);
    if (!this.blobs.has(digest)) this.blobs.set(digest, bytes);
    return {
      cid: input.cid ? String(input.cid) : null,
      contentType: input.contentType,
      digest,
      bytes: bytes.byteLength,
    };
  }

  create(request: CreateSnapshotRequest): SnapshotManifest {
    const template = this.lookupTemplate(String(request.templateId ?? ''));
    if (!template) throw new SnapshotError(404, 'not_found', 'unknown template');
    if (typeof request.revision !== 'number' || request.revision !== template.revision) {
      // A snapshot must freeze a revision the caller has actually seen; a missing
      // revision or a draft save in between forces a fresh reload first.
      throw new SnapshotError(409, 'revision_conflict', 'template revision moved; reload before snapshotting');
    }

    const resources = (request.resources ?? []).map(resource => this.putResource(resource));
    const templateBytes = Buffer.from(template.content, 'utf8');
    const templateDigest = sha256(templateBytes);
    if (!this.blobs.has(templateDigest)) this.blobs.set(templateDigest, templateBytes);

    const capabilities = normalizeCapabilities(request.capabilities);
    const mimeParts = this.buildMimeTree(template.contentType ?? 'text/html', templateDigest, templateBytes.byteLength, resources);
    const degradation = buildDegradation(template.content, resources, capabilities);

    const createdAt = this.now();
    const expiresAtMs = createdAt + this.ttlMs;
    const unsigned = {
      id: shortId(),
      templateId: template.id,
      templateRevision: template.revision,
      templateDigest,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      capabilities,
      resources: resources.map(({cid, contentType, digest, bytes}) => ({cid, contentType, digest, bytes})),
      mimeParts,
      degradation,
    };
    const signature = hmac(this.secret, canonicalJson(unsigned));
    const manifest: SnapshotManifest = {...unsigned, signature};
    this.manifests.set(manifest.id, manifest);
    return manifest;
  }

  async read(id: string): Promise<SnapshotView> {
    await this.lock.acquireRead();
    try {
      await this.onReadAcquired?.();
      const manifest = this.manifests.get(id);
      if (!manifest) throw new SnapshotError(404, 'not_found', 'snapshot does not exist');
      if (manifest.expiresAtMs <= this.now()) {
        throw new SnapshotError(410, 'snapshot_expired', 'snapshot has expired');
      }

      // 1. Whole-manifest signature: any field-level tampering is rejected here.
      const {signature, ...unsigned} = manifest;
      const expected = hmac(this.secret, canonicalJson(unsigned));
      if (!safeEqual(expected, signature)) {
        throw new SnapshotError(409, 'manifest_tampered', 'snapshot manifest failed signature verification');
      }

      // 2. Frozen template bytes, verified item by item against the manifest digest.
      const templateBytes = this.blobs.get(manifest.templateDigest);
      if (!templateBytes || sha256(templateBytes) !== manifest.templateDigest) {
        throw new SnapshotError(409, 'resource_integrity_failed', 'pinned template content is missing or altered');
      }

      // 3. Every referenced resource: existence then content digest.
      for (const item of manifest.resources) {
        const bytes = this.blobs.get(item.digest);
        if (!bytes) {
          throw new SnapshotError(409, 'resource_integrity_failed', `resource ${item.digest} is missing`);
        }
        if (sha256(bytes) !== item.digest) {
          throw new SnapshotError(409, 'resource_integrity_failed', `resource ${item.digest} was altered`);
        }
      }

      const liveTemplate = this.lookupTemplate(manifest.templateId);
      return {
        id: manifest.id,
        readOnly: true,
        templateId: manifest.templateId,
        templateRevision: manifest.templateRevision,
        templateName: liveTemplate?.name ?? manifest.templateId,
        templateContent: Buffer.from(templateBytes).toString('utf8'),
        templateDigest: manifest.templateDigest,
        createdAt: manifest.createdAt,
        expiresAt: manifest.expiresAt,
        capabilities: manifest.capabilities,
        resources: manifest.resources.map(item => ({
          cid: item.cid,
          contentType: item.contentType,
          digest: item.digest,
          bytes: item.bytes,
          contentBase64: Buffer.from(this.blobs.get(item.digest)!).toString('base64'),
        })),
        mimeParts: manifest.mimeParts,
        degradation: manifest.degradation,
        signature: manifest.signature,
        currentTemplateRevision: liveTemplate?.revision ?? manifest.templateRevision,
        stale: liveTemplate ? liveTemplate.revision !== manifest.templateRevision : false,
      };
    } finally {
      this.lock.releaseRead();
    }
  }

  async deleteResource(digest: string): Promise<void> {
    await this.lock.acquireWrite();
    try {
      if (!this.blobs.has(digest)) throw new SnapshotError(404, 'not_found', 'unknown resource digest');
      for (const manifest of this.manifests.values()) {
        if (manifest.expiresAtMs <= this.now()) continue;
        if (manifest.templateDigest === digest || manifest.resources.some(item => item.digest === digest)) {
          throw new SnapshotError(409, 'resource_in_use', 'resource is referenced by a snapshot');
        }
      }
      this.blobs.delete(digest);
    } finally {
      this.lock.releaseWrite();
    }
  }

  // Remove expired snapshots and only the blobs no remaining snapshot references.
  async cleanup(): Promise<{removedSnapshots: number; removedBlobs: number}> {
    await this.lock.acquireWrite();
    try {
      let removedSnapshots = 0;
      for (const [id, manifest] of this.manifests) {
        if (manifest.expiresAtMs <= this.now()) {
          this.manifests.delete(id);
          removedSnapshots += 1;
        }
      }
      const referenced = new Set<string>();
      for (const manifest of this.manifests.values()) {
        referenced.add(manifest.templateDigest);
        for (const item of manifest.resources) referenced.add(item.digest);
      }
      let removedBlobs = 0;
      for (const digest of this.blobs.keys()) {
        if (!referenced.has(digest)) {
          this.blobs.delete(digest);
          removedBlobs += 1;
        }
      }
      return {removedSnapshots, removedBlobs};
    } finally {
      this.lock.releaseWrite();
    }
  }

  list(): Array<{id: string; templateId: string; templateRevision: number; createdAt: string; expiresAt: string}> {
    return [...this.manifests.values()]
      .filter(manifest => manifest.expiresAtMs > this.now())
      .map(({id, templateId, templateRevision, createdAt, expiresAt}) => ({
        id,
        templateId,
        templateRevision,
        createdAt,
        expiresAt,
      }));
  }

  // Tree shape pinned into the manifest:
  //   "0"      -> template body (text/html or text/plain), content-addressed
  //   "1/<i>"  -> i-th related resource under multipart/related (images/etc.)
  private buildMimeTree(
    templateContentType: string,
    templateDigest: string,
    templateBytes: number,
    resources: StoredResource[],
  ): MimePart[] {
    return [
      {path: '0', contentType: templateContentType, cid: null, digest: templateDigest, bytes: templateBytes},
      ...resources.map((resource, index) => ({
        path: `1/${index}`,
        contentType: resource.contentType,
        cid: resource.cid,
        digest: resource.digest,
        bytes: resource.bytes,
      })),
    ];
  }
}

function normalizeCapabilities(partial: Partial<ClientCapabilities> | undefined): ClientCapabilities {
  const imageTypes = partial?.imageTypes;
  return {
    viewportWidth: numberOrDefault(partial?.viewportWidth, DEFAULT_CAPABILITIES.viewportWidth),
    images: partial?.images ?? DEFAULT_CAPABILITIES.images,
    css: partial?.css ?? DEFAULT_CAPABILITIES.css,
    imageTypes: Array.isArray(imageTypes) ? imageTypes.map(String) : DEFAULT_CAPABILITIES.imageTypes,
    userAgent: partial?.userAgent ? String(partial.userAgent) : DEFAULT_CAPABILITIES.userAgent,
  };
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function buildDegradation(
  templateContent: string,
  resources: StoredResource[],
  capabilities: ClientCapabilities,
): DegradationNote[] {
  const notes: DegradationNote[] = [];
  for (const resource of resources) {
    if (!resource.contentType.startsWith('image/')) continue;
    const label = resource.cid ? `cid:${resource.cid}` : resource.digest.slice(0, 12);
    if (!capabilities.images) {
      notes.push({
        code: 'images_unavailable',
        message: `${label} (${resource.contentType}) is hidden because this client cannot render embedded images.`,
        cid: resource.cid ?? undefined,
        contentType: resource.contentType,
      });
    } else if (!capabilities.imageTypes.includes(resource.contentType)) {
      notes.push({
        code: 'image_type_unsupported',
        message: `${label} is ${resource.contentType}; supported types are ${capabilities.imageTypes.join(', ')}.`,
        cid: resource.cid ?? undefined,
        contentType: resource.contentType,
      });
    }
  }
  if (!capabilities.css && /<style[\s>]|style\s*=/.test(templateContent)) {
    notes.push({
      code: 'css_stripped',
      message: 'CSS <style> blocks and style attributes are removed for this client; layout falls back to table/inline.',
    });
  }
  for (const resource of resources) {
    if (resource.bytes > LARGE_RESOURCE_BYTES) {
      notes.push({
        code: 'resource_large',
        message: `${resource.cid ? `cid:${resource.cid}` : resource.contentType} is ${(resource.bytes / 1024).toFixed(0)} KiB; it may be clipped on slow clients.`,
        cid: resource.cid ?? undefined,
        contentType: resource.contentType,
      });
    }
  }
  return notes;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function isValidBase64(source: string, decoded: Buffer): boolean {
  // Buffer.from never throws on malformed base64; require a canonical round-trip.
  const normalized = source.replace(/[^A-Za-z0-9+/=]/g, '');
  return Buffer.from(decoded).toString('base64') === normalized;
}
