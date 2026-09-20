// Shared types for the read-only snapshot feature.
// Type-only module: safe to import from both server and client code.

export type ClientProfile = {
  id: string;
  label: string;
  capabilities: Record<string, boolean>;
};

export type ManifestResource = {
  name: string;
  digest: string;
  size: number;
};

export type Degradation = {
  feature: string;
  /** MIME part where the triggering markup/resource lives. */
  partId: string;
  /** 1-based line in the text/html source, when applicable. */
  line: number | null;
  detail: string;
  fallback: string;
  explanation: string;
};

export type MimePart = {
  partId: string;
  contentType: string;
  name: string;
  size: number;
  digest: string | null;
};

export type RenderAnalysis = {
  clientProfile: ClientProfile;
  mimeParts: MimePart[];
  degradations: Degradation[];
};

export type SnapshotManifest = {
  version: 1;
  templateId: string;
  /** Template revision pinned at snapshot time. */
  revision: number;
  /** Pinned template content, stored as a content-addressed resource. */
  template: {digest: string; size: number};
  /** Full client capability config pinned at snapshot time. */
  clientProfile: ClientProfile;
  resources: ManifestResource[];
  analysis: RenderAnalysis;
  createdAt: string;
  expiresAt: string;
};

export type SnapshotResourceView = ManifestResource & {content: string};

/** Payload returned by GET /api/snapshots/:id */
export type SnapshotView = {
  id: string;
  manifest: SnapshotManifest;
  signature: string;
  template: {digest: string; size: number; content: string};
  resources: SnapshotResourceView[];
  /** Revision of the live draft at read time; null when the template is gone. */
  currentRevision: number | null;
};

export type SnapshotErrorCode =
  | 'not_found'
  | 'expired'
  | 'manifest_tampered'
  | 'resource_missing'
  | 'resource_tampered'
  | 'revision_conflict'
  | 'template_not_found'
  | 'unknown_client_profile'
  | 'invalid_resource';
