/**
 * Structured-output parity across the two completion adapters, exercised with
 * the *actual* Phase 8 service JSON Schemas.
 *
 * These fixtures are the verbatim `zodToJsonSchema` output of the shared zod
 * schemas in `@meridian/ai-services` (src/schemas.ts): `rollupSummarySchema`
 * for summarize and `extractedStructureSchema` for extract. They are inlined
 * rather than imported because `@meridian/ai` sits *below* ai-services in the
 * dependency law (§20) — ai must not import it. If those schemas change, the
 * gateway's own `zodToJsonSchema` regenerates the request; these fixtures only
 * need to stay representative of the real optional/open/bounded shapes.
 *
 * The finding under test: the OpenAI adapter must not blindly send
 * `strict: true`. The summarize schema carries value bounds
 * (min/maxLength, min/max), and the extract schema has an optional `attrs`
 * property that is itself an open `z.record` dictionary — all of which OpenAI's
 * strict Structured Outputs rejects but Anthropic's tool `input_schema`
 * accepts. Both adapters must send a request the intended provider mode accepts,
 * while the gateway's zod validation + one repair stay authoritative on shape.
 */
import { describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  type AnthropicCreateParams,
  type AnthropicMessage,
  type AnthropicMessagesClient,
} from '../../src/providers/anthropic.js';
import {
  isOpenAiStrictCompatible,
  OpenAiProvider,
  type OpenAiChatCompletion,
  type OpenAiChatParams,
  type OpenAiClient,
} from '../../src/providers/openai.js';
import type { CompletionRequest, JsonSchema, ProviderCapabilities } from '../../src/types.js';

// --- Real service JSON Schemas (verbatim zodToJsonSchema output) ------------

/** `zodToJsonSchema(rollupSummarySchema)` — bounded strings + a bounded number. */
const SUMMARIZE_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    summary: { type: 'string', minLength: 1, maxLength: 400 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['name', 'summary', 'confidence'],
  additionalProperties: false,
};

/**
 * `zodToJsonSchema(extractedStructureSchema)` — nested objects with an optional
 * `attrs` property that is an open dictionary (`z.record`): `propertyNames` +
 * schema-valued `additionalProperties`, plus `pattern` on `kind`.
 */
const EXTRACT_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          kind: { type: 'string', pattern: '^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$' },
          label: { type: 'string' },
          attrs: {
            type: 'object',
            propertyNames: { type: 'string', pattern: '^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$' },
            additionalProperties: {
              anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
            },
          },
        },
        required: ['id', 'kind', 'label'],
        additionalProperties: false,
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          src: { type: 'string', minLength: 1 },
          dst: { type: 'string', minLength: 1 },
          kind: { type: 'string', pattern: '^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$' },
        },
        required: ['id', 'src', 'dst', 'kind'],
        additionalProperties: false,
      },
    },
  },
  required: ['nodes', 'edges'],
  additionalProperties: false,
};

/** A schema fully inside OpenAI's strict subset (closed object, all required). */
const STRICT_OK_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { label: { type: 'string' } },
  required: ['label'],
  additionalProperties: false,
};

const CAPS: ProviderCapabilities = {
  completion: true,
  embedding: true,
  models: { 'gpt-x': { inputPerMTok: 2, outputPerMTok: 8 } },
};

const ANTHROPIC_CAPS: ProviderCapabilities = {
  completion: true,
  embedding: false,
  models: { 'claude-x': { inputPerMTok: 3, outputPerMTok: 15 } },
};

// --- OpenAI fake ------------------------------------------------------------

interface ChatState {
  params?: OpenAiChatParams;
}

function fakeOpenAi(completion: OpenAiChatCompletion): { client: OpenAiClient; state: ChatState } {
  const state: ChatState = {};
  const client: OpenAiClient = {
    chat: {
      completions: {
        create: (params) => {
          state.params = params;
          return Promise.resolve(completion);
        },
      },
    },
    embeddings: { create: () => Promise.reject(new Error('unused')) },
  };
  return { client, state };
}

function openAiCompletion(content: string | null, refusal?: string): OpenAiChatCompletion {
  return {
    id: 'c',
    model: 'gpt-x',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, ...(refusal ? { refusal } : {}) },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function openAiRequest(outputSchema: JsonSchema): CompletionRequest {
  return {
    model: 'gpt-x',
    messages: [{ role: 'user', content: 'go' }],
    maxOutputTokens: 100,
    outputSchema,
  };
}

// --- Anthropic fake ---------------------------------------------------------

interface MsgState {
  params?: AnthropicCreateParams;
}

function fakeAnthropic(message: AnthropicMessage): { client: AnthropicMessagesClient; state: MsgState } {
  const state: MsgState = {};
  const client: AnthropicMessagesClient = {
    messages: {
      create: (params) => {
        state.params = params;
        return Promise.resolve(message);
      },
    },
  };
  return { client, state };
}

function anthropicMessage(input: unknown): AnthropicMessage {
  return {
    id: 'm',
    model: 'claude-x',
    role: 'assistant',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 't', name: 'emit_structured_result', input }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function anthropicRequest(outputSchema: JsonSchema): CompletionRequest {
  return {
    model: 'claude-x',
    messages: [{ role: 'user', content: 'go' }],
    maxOutputTokens: 100,
    outputSchema,
  };
}

// ---------------------------------------------------------------------------

describe('isOpenAiStrictCompatible — the real Phase 8 schemas', () => {
  it('rejects the summarize schema (value bounds are outside the strict subset)', () => {
    expect(isOpenAiStrictCompatible(SUMMARIZE_SCHEMA)).toBe(false);
  });

  it('rejects the extract schema (optional attrs + open z.record dictionary)', () => {
    expect(isOpenAiStrictCompatible(EXTRACT_SCHEMA)).toBe(false);
  });

  it('accepts a closed, fully-required, unbounded object', () => {
    expect(isOpenAiStrictCompatible(STRICT_OK_SCHEMA)).toBe(true);
  });

  it('rejects an object missing additionalProperties:false', () => {
    expect(isOpenAiStrictCompatible({ type: 'object', properties: {}, required: [] })).toBe(false);
  });

  it('rejects an object with an optional property (not in required)', () => {
    expect(
      isOpenAiStrictCompatible({
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        required: ['a'],
        additionalProperties: false,
      }),
    ).toBe(false);
  });

  it('rejects a nested open dictionary even when the outer object is closed', () => {
    expect(
      isOpenAiStrictCompatible({
        type: 'object',
        properties: {
          map: { type: 'object', additionalProperties: { type: 'string' } },
        },
        required: ['map'],
        additionalProperties: false,
      }),
    ).toBe(false);
  });
});

describe('OpenAiProvider.complete — request shape for the real schemas', () => {
  it('sends json_schema with strict:false for the summarize schema, and parses valid content', async () => {
    const payload = { name: 'N', summary: 'S', confidence: 0.9 };
    const fake = fakeOpenAi(openAiCompletion(JSON.stringify(payload)));
    const provider = new OpenAiProvider({ capabilities: CAPS, client: fake.client });

    const result = await provider.complete(openAiRequest(SUMMARIZE_SCHEMA));

    const rf = fake.state.params?.response_format;
    expect(rf?.type).toBe('json_schema');
    expect(rf?.json_schema.strict).toBe(false);
    // The schema crosses the boundary unweakened — bounds are still present.
    expect(rf?.json_schema.schema).toEqual(SUMMARIZE_SCHEMA);
    expect(result.structured).toEqual(payload);
    expect(result.stopReason).toBe('stop');
  });

  it('sends json_schema with strict:false for the extract schema (open/optional attrs)', async () => {
    const payload = { nodes: [], edges: [] };
    const fake = fakeOpenAi(openAiCompletion(JSON.stringify(payload)));
    const provider = new OpenAiProvider({ capabilities: CAPS, client: fake.client });

    await provider.complete(openAiRequest(EXTRACT_SCHEMA));

    const rf = fake.state.params?.response_format;
    expect(rf?.json_schema.strict).toBe(false);
    expect(rf?.json_schema.schema).toEqual(EXTRACT_SCHEMA);
  });

  it('sends strict:true only when the schema is inside the strict subset', async () => {
    const fake = fakeOpenAi(openAiCompletion('{"label":"x"}'));
    const provider = new OpenAiProvider({ capabilities: CAPS, client: fake.client });

    await provider.complete(openAiRequest(STRICT_OK_SCHEMA));

    expect(fake.state.params?.response_format?.json_schema.strict).toBe(true);
  });

  it('leaves structured undefined for malformed JSON so the gateway can repair', async () => {
    const fake = fakeOpenAi(openAiCompletion('{"name": "N", not json'));
    const provider = new OpenAiProvider({ capabilities: CAPS, client: fake.client });

    const result = await provider.complete(openAiRequest(SUMMARIZE_SCHEMA));

    // Request shape is still the accepted non-strict mode…
    expect(fake.state.params?.response_format?.json_schema.strict).toBe(false);
    // …and a malformed body surfaces as undefined structured (not a throw).
    expect(result.structured).toBeUndefined();
  });

  it('maps a refusal to a refusal stop reason regardless of schema', async () => {
    const fake = fakeOpenAi(openAiCompletion(null, 'no'));
    const provider = new OpenAiProvider({ capabilities: CAPS, client: fake.client });

    const result = await provider.complete(openAiRequest(EXTRACT_SCHEMA));

    expect(result.stopReason).toBe('refusal');
    expect(result.structured).toBeUndefined();
  });
});

describe('AnthropicProvider.complete — the same schemas pass through untouched', () => {
  it('forwards the summarize schema verbatim as the forced tool input_schema', async () => {
    const payload = { name: 'N', summary: 'S', confidence: 0.5 };
    const fake = fakeAnthropic(anthropicMessage(payload));
    const provider = new AnthropicProvider({ capabilities: ANTHROPIC_CAPS, client: fake.client });

    const result = await provider.complete(anthropicRequest(SUMMARIZE_SCHEMA));

    expect(fake.state.params?.tools?.[0]?.input_schema).toEqual(SUMMARIZE_SCHEMA);
    expect(fake.state.params?.tool_choice).toEqual({ type: 'tool', name: 'emit_structured_result' });
    expect(result.structured).toEqual(payload);
    expect(result.stopReason).toBe('stop');
  });

  it('forwards the extract schema verbatim, open dictionary and all', async () => {
    const payload = {
      nodes: [{ id: 'n1', kind: 'ns:thing', label: 'L', attrs: { 'ns:weight': 3 } }],
      edges: [],
    };
    const fake = fakeAnthropic(anthropicMessage(payload));
    const provider = new AnthropicProvider({ capabilities: ANTHROPIC_CAPS, client: fake.client });

    const result = await provider.complete(anthropicRequest(EXTRACT_SCHEMA));

    expect(fake.state.params?.tools?.[0]?.input_schema).toEqual(EXTRACT_SCHEMA);
    expect(result.structured).toEqual(payload);
  });

  it('leaves structured undefined when the model emits no tool call', async () => {
    const message: AnthropicMessage = {
      id: 'm',
      model: 'claude-x',
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'sorry' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const provider = new AnthropicProvider({
      capabilities: ANTHROPIC_CAPS,
      client: fakeAnthropic(message).client,
    });

    const result = await provider.complete(anthropicRequest(EXTRACT_SCHEMA));

    expect(result.structured).toBeUndefined();
  });
});
