/**
 * In-process code mapper used by conformance and unit tests. The parser shim
 * is imported lazily: merely importing `@meridian/adapter-code` must not load
 * web-tree-sitter into a production application's main thread.
 */
import { buildBody } from './detail/body.js';
import { mapModuleTree } from './map/map-module.js';
import type { CodeMapper } from './mapper.js';
import { parseSource } from './parse.js';
import type { ParserRuntime, ParserRuntimeOptions } from './shim.js';

/** In-process mapper (parse + map on the calling thread). Test-only path. */
export function createInProcessMapper(runtimeOptions: ParserRuntimeOptions): CodeMapper {
  let runtime: Promise<ParserRuntime> | undefined;
  const getRuntime = (): Promise<ParserRuntime> => {
    if (runtime === undefined) {
      runtime = import('./shim.js').then(({ createParserRuntime }) =>
        createParserRuntime(runtimeOptions),
      );
      runtime.catch(() => (runtime = undefined));
    }
    return runtime;
  };
  return {
    async mapModule(req) {
      const parser = await (await getRuntime()).parser(req.language);
      try {
        const { tree } = parseSource(parser, req.language, req.text);
        try {
          return mapModuleTree(tree, req.language, { source: req.source, label: req.label });
        } finally {
          tree.delete();
        }
      } finally {
        parser.delete();
      }
    },
    async resolveBody(req) {
      const parser = await (await getRuntime()).parser(req.language);
      try {
        const { tree } = parseSource(parser, req.language, req.text);
        try {
          return buildBody(tree, req.language, req.declSpan);
        } finally {
          tree.delete();
        }
      } finally {
        parser.delete();
      }
    },
    async dispose() {
      /* the runtime holds no OS handles; nothing to release */
    },
  };
}
