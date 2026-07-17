import {
  createParseWorker,
  type CodeLanguage,
  type WorkerControlChannel,
} from '@meridian/adapter-code/worker-runtime';
import * as Comlink from 'comlink';
import typescriptGrammarUrl from '@meridian/adapter-code/grammars/tree-sitter-typescript.wasm?url';
import pythonGrammarUrl from '@meridian/adapter-code/grammars/tree-sitter-python.wasm?url';
import treeSitterRuntimeUrl from 'web-tree-sitter/web-tree-sitter.wasm?url';

interface CodeInitMessage {
  readonly type: 'meridian-code-init';
  readonly controlPort: MessagePort;
}

function isInitMessage(value: unknown): value is CodeInitMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'meridian-code-init' &&
    (value as { controlPort?: unknown }).controlPort instanceof MessagePort
  );
}

const grammarUrls: Record<CodeLanguage, string> = {
  typescript: typescriptGrammarUrl,
  python: pythonGrammarUrl,
};
const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

const initialize = (event: MessageEvent<unknown>): void => {
  if (!isInitMessage(event.data)) return;
  scope.removeEventListener('message', initialize);
  const port = event.data.controlPort;
  port.start();
  const control: WorkerControlChannel = {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => {
      port.addEventListener('message', (message: MessageEvent<unknown>) => listener(message.data as never));
    },
  };
  const readGrammar = async (language: CodeLanguage): Promise<Uint8Array> => {
    const response = await fetch(grammarUrls[language]);
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${language} grammar`);
    return new Uint8Array(await response.arrayBuffer());
  };
  Comlink.expose(
    createParseWorker({
      runtime: {
        readGrammar,
        locateFile: (path) => path.endsWith('.wasm') ? treeSitterRuntimeUrl : path,
      },
      control,
    }),
    scope,
  );
};

scope.addEventListener('message', initialize);
