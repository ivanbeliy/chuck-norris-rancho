import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<string>();

// stdio mode: identity fixed via env on startup.
// http mode: identity per-request from X-Chuck-Client header; stored in ALS.
// Tool handlers call getIdentity() and get whichever is active.

let stdioIdentity: string = process.env.CHUCK_WIKI_CLIENT_IDENTITY ?? 'unknown';

export function setStdioIdentity(id: string): void {
  stdioIdentity = id;
}

export function getIdentity(): string {
  return store.getStore() ?? stdioIdentity;
}

export function runWithIdentity<T>(identity: string, fn: () => T | Promise<T>): T | Promise<T> {
  return store.run(identity, fn);
}
