export { CODE_LANGUAGES, GRAMMAR_FILES, isCodeLanguage } from './languages.js';
export type { CodeLanguage } from './languages.js';
export { createParserRuntime } from './shim.js';
export type { GrammarSource, ParserRuntime, ParserRuntimeOptions } from './shim.js';
export { MAX_REPORTED_SYNTAX_ERRORS, parseSource, summarizeTree } from './parse.js';
export type { ParseOutcome, SyntaxErrorSpan, TextPosition } from './parse.js';
export { abortError, createParseWorker } from './worker/worker-api.js';
export type {
  CancelledMessage,
  CancelMessage,
  ParseRequest,
  ParseResponse,
  ParseWorkerApi,
  WorkerControlChannel,
} from './worker/worker-api.js';
export { ParseWorkerHost } from './worker/host.js';
export type {
  CrashInfo,
  HostControlChannel,
  ParseHostOptions,
  ParseHostStats,
  ParseWorkerHostOptions,
  WorkerFactory,
  WorkerHandle,
} from './worker/host.js';
export type { MapRequest, MapResponse } from './worker/worker-api.js';

// 7C — TypeScript mapping (eager levels).
export type { RawDecl, RawDeclKind, RawModule, RawSignature } from './map/raw.js';
export { mapTypeScriptModule } from './map/typescript.js';
export {
  extractSignature,
  fnv1a,
  nameOf,
  normalizeWs,
  signatureHash,
} from './map/signature.js';
export { assembleProject } from './map/assemble.js';
export type { RawDir } from './map/assemble.js';
export { assignSegments, buildCodeDocument, DOMAIN } from './document.js';
export {
  CODE_PROJECT_MEDIA_TYPE,
  decodeProjectBundle,
  encodeProjectBundle,
  normalizePosixPath,
} from './bundle.js';
export type { BundleFile, CodeProjectBundle } from './bundle.js';
export {
  createInProcessMapper,
  createWorkerMapper,
} from './mapper.js';
export type { CodeMapper, MapModuleRequest } from './mapper.js';
export { createCodePlugin, manifest as codeManifest } from './plugin.js';
