// Types shared between the snapshot server and the read-only client view.
// This module must not import Node-only APIs.

export interface ClientCapabilities {
  // Viewport width in CSS pixels; used for layout degradation notes.
  viewportWidth: number;
  // True when the client can render embedded images (e.g. cid: parts).
  images: boolean;
  // True when the client applies CSS <style> blocks; otherwise inline styles only.
  css: boolean;
  // Accepted image MIME types, ordered by preference.
  imageTypes: string[];
  // Free-form client identifier (engine name/version).
  userAgent: string;
}

export interface ResourceInput {
  // CID referenced from the template, e.g. "logo" -> cid:logo. Optional.
  cid?: string;
  // Media type of the resource.
  contentType: string;
  // Raw bytes encoded as base64.
  contentBase64?: string;
  // Convenience for text resources; encoded as UTF-8.
  contentText?: string;
}

export interface MimePart {
  // Stable locator inside the rendered MIME tree, e.g. "0/1/0".
  path: string;
  contentType: string;
  cid: string | null;
  digest: string;
  bytes: number;
}

export interface DegradationNote {
  code: 'images_unavailable' | 'image_type_unsupported' | 'css_stripped' | 'resource_large';
  message: string;
  cid?: string;
  contentType?: string;
}

export interface SnapshotManifest {
  id: string;
  templateId: string;
  // Revision of the template that was frozen into the snapshot.
  templateRevision: number;
  templateDigest: string;
  createdAt: string;
  expiresAt: string;
  // Epoch-millisecond expiry used by server-side TTL checks (the ISO string
  // truncates milliseconds; the pinned value keeps the boundary exact).
  expiresAtMs: number;
  capabilities: ClientCapabilities;
  resources: Array<{
    cid: string | null;
    contentType: string;
    digest: string;
    bytes: number;
  }>;
  mimeParts: MimePart[];
  degradation: DegradationNote[];
  // HMAC over the canonical JSON of every field above.
  signature: string;
}

export interface SnapshotResourceView {
  cid: string | null;
  contentType: string;
  digest: string;
  bytes: number;
  contentBase64: string;
}

export interface SnapshotView {
  id: string;
  readOnly: true;
  templateId: string;
  templateRevision: number;
  templateName: string;
  templateContent: string;
  templateDigest: string;
  createdAt: string;
  expiresAt: string;
  capabilities: ClientCapabilities;
  resources: SnapshotResourceView[];
  mimeParts: MimePart[];
  degradation: DegradationNote[];
  signature: string;
  // Revision the live, editable template has reached since the snapshot was taken.
  // May differ from templateRevision; the snapshot content is never mutated.
  currentTemplateRevision: number;
  stale: boolean;
}

export interface CreateSnapshotRequest {
  templateId: string;
  revision: number;
  capabilities?: Partial<ClientCapabilities>;
  resources?: ResourceInput[];
}
