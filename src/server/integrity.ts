import {createHash,createHmac,randomBytes} from 'node:crypto';

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function hmac(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

export function randomSecret(): string {
  return randomBytes(32).toString('hex');
}

// URL-safe short id for local short links.
export function shortId(): string {
  return randomBytes(8).toString('base64url');
}

// Deterministic canonical serialization: object keys sorted recursively so that
// the manifest signature is independent of property insertion order.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
}
