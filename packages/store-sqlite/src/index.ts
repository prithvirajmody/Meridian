export type { SqlDriver, SqlRow, SqlValue } from './driver.js';
export {
  initializeSchema,
  integrityFindings,
  isMeridianProject,
  META_CHECKPOINT_SEQ,
  META_FORMAT_VERSION,
  META_LAST_COUNTER,
  META_PRODUCER,
  META_SCHEMA_VERSION,
  migrateSchema,
  readMetaValue,
  STORAGE_MIGRATIONS,
  STORAGE_SCHEMA_VERSION,
  writeMetaValue,
} from './schema.js';
export type { StorageMigration } from './schema.js';
export {
  DEFAULT_CHECKPOINT_EVERY,
  loadSpace,
  SqliteBackendCore,
  SqliteStorageBackend,
} from './core.js';
export type { CoreOptions, GraphSummary, OpenedState } from './core.js';
export { salvageToDocument } from './salvage.js';
export type { SalvageResult } from './salvage.js';
