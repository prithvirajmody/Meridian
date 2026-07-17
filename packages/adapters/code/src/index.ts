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

// 7C — TypeScript mapping (eager levels). 7D — Python mapping (eager levels).
export type {
  CallReceiver,
  RawCallSite,
  RawDecl,
  RawDeclKind,
  RawImport,
  RawImportBinding,
  RawModule,
  RawSignature,
} from './map/raw.js';
// 7E — import/call resolution (pure).
export { resolveEdges } from './map/resolve.js';
export type {
  Address,
  DeclRef,
  EdgeToEmit,
  FunctionCounters,
  FunctionCtx,
  ModuleCtx,
  ResolveInput,
  ResolveOutput,
} from './map/resolve.js';
export { mapTypeScriptModule } from './map/typescript.js';
export { mapPythonModule } from './map/python.js';
export { mapModuleTree } from './map/map-module.js';
export type { MapModuleOptions } from './map/map-module.js';
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
export { createInProcessMapper } from './in-process-mapper.js';
export { createWorkerMapper } from './worker-mapper.js';
export type { CodeMapper, MapModuleRequest, ResolveBodyRequest } from './mapper.js';
export { languageForPath } from './languages.js';
export { createCodePlugin, manifest as codeManifest } from './plugin.js';
// 7F — CFG & lazy AST (DetailResolver).
export { buildCfg } from './detail/cfg.js';
export type { CfgBlock, CfgEdge, CfgResult } from './detail/cfg.js';
export { normalizeTsBody } from './detail/ts-body.js';
export { normalizePyBody } from './detail/py-body.js';
export { buildAst } from './detail/ast.js';
export { buildBody } from './detail/body.js';
export type {
  CfgCase,
  CfgStmt,
  FlowLabel,
  RawAst,
  RawBlock,
  RawBody,
  RawFlow,
} from './detail/types.js';
export { buildBodyDelta, DETAIL_ACTOR, DetailResolveError } from './detail/build-detail.js';
export { canResolveCodeDetail, createCodeDetailResolver } from './detail/resolver.js';
export type { CodeDetailResolverDeps } from './detail/resolver.js';
export { CODE_EXTENSIONS, mapFileToModule, oversizeReason } from './map/map-file.js';
// 7G — incremental watch mode & minimal deltas (ADR-0028, ADR-0027 composition).
export { diffCodeDocuments } from './incremental/diff.js';
export { buildBodyGraphs } from './incremental/body-graphs.js';
export type { BodyGraphs } from './incremental/body-graphs.js';
export {
  CodeIncrementalSession,
  createCodeIncrementalSession,
  INCREMENTAL_ACTOR,
} from './incremental/session.js';
export type {
  CodeIncrementalSessionDeps,
  CodeProjectState,
} from './incremental/session.js';
export type {
  ResolveBodyRequest as WorkerResolveBodyRequest,
  ResolveBodyResponse as WorkerResolveBodyResponse,
} from './worker/worker-api.js';
