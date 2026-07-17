/**
 * Located browser-persistence capability result. SQLite WASM itself is not a
 * durability claim: Meridian only calls the browser backend durable after the
 * worker can use OPFS SyncAccessHandles and install the SAH-pool VFS.
 */

export type BrowserStorageCapabilityLocation =
  | 'navigator.storage.getDirectory'
  | 'FileSystemFileHandle.createSyncAccessHandle'
  | 'opfs-sah-pool'
  | 'host-policy'
  | 'storage-worker';

export interface DurableBrowserStorageCapability {
  readonly ok: true;
  readonly mode: 'opfs';
  readonly durability: 'durable';
  readonly location: 'opfs-sah-pool';
}

/** Browser APIs exist, but the worker has not yet proved VFS installation. */
export interface BrowserStoragePrerequisitesPresent {
  readonly ok: true;
  readonly mode: 'opfs';
  readonly durability: 'unverified';
  readonly location: 'FileSystemFileHandle.createSyncAccessHandle';
}

export interface VolatileBrowserStorageCapability {
  readonly ok: false;
  readonly mode: 'memory';
  readonly durability: 'volatile';
  readonly code: 'opfs-unavailable';
  readonly location: BrowserStorageCapabilityLocation;
  readonly reason: string;
}

export type BrowserStorageCapability =
  | DurableBrowserStorageCapability
  | VolatileBrowserStorageCapability;

export type BrowserStoragePrerequisiteResult =
  | BrowserStoragePrerequisitesPresent
  | VolatileBrowserStorageCapability;

interface CapabilityScope {
  readonly navigator?: { readonly storage?: { readonly getDirectory?: unknown } };
  readonly FileSystemFileHandle?: { readonly prototype: object };
}

export function volatileBrowserStorage(
  location: BrowserStorageCapabilityLocation,
  reason: string,
): VolatileBrowserStorageCapability {
  return {
    ok: false,
    mode: 'memory',
    durability: 'volatile',
    code: 'opfs-unavailable',
    location,
    reason,
  };
}

export function durableBrowserStorage(): DurableBrowserStorageCapability {
  return { ok: true, mode: 'opfs', durability: 'durable', location: 'opfs-sah-pool' };
}

/** Pure feature probe; installing the VFS is the worker's second-stage probe. */
export function detectBrowserStorageCapability(
  scope: CapabilityScope = globalThis as CapabilityScope,
): BrowserStoragePrerequisiteResult {
  if (typeof scope.navigator?.storage?.getDirectory !== 'function') {
    return volatileBrowserStorage(
      'navigator.storage.getDirectory',
      'navigator.storage.getDirectory is unavailable',
    );
  }
  const fileHandle = scope.FileSystemFileHandle;
  if (!fileHandle || !('createSyncAccessHandle' in fileHandle.prototype)) {
    return volatileBrowserStorage(
      'FileSystemFileHandle.createSyncAccessHandle',
      'FileSystemFileHandle.createSyncAccessHandle is unavailable (no sync access handles in this context)',
    );
  }
  return {
    ok: true,
    mode: 'opfs',
    durability: 'unverified',
    location: 'FileSystemFileHandle.createSyncAccessHandle',
  };
}
