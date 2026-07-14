# @meridian/ai

The AI gateway (ROADMAP Phase 8, ARCHITECTURE §8). One vendor-neutral
`AiProvider` seam and an `AiSession` pipeline sit between every service and
every model vendor. Nothing above the provider adapters ever sees a vendor SDK
type (§20).

## Pipeline (`AiSession.call`)

    cache/replay hit → budget precheck → provider (bounded backoff on transient)
      → zod validate → exactly one repair attempt → typed rejection

- **Cache / replay** (`SessionMode`): `off` (no cache), `live` (cache-through),
  `record` (always call + write fixtures), `replay` (read-only; a miss is a hard
  `replay_miss` error and **no** provider call — CI runs with the network off,
  ADR-0030). Ordinary live-cache hits are free; replay hits are metered from
  recorded usage while still skipping the provider. Response keys carry
  `providerId`, concrete `model`, `promptVersion`, and the canonical `inputHash`.
- **Budget** (`BudgetGuard`, ADR-0032): session token and dollar ceilings; a
  mid-run trip rejects the *next* call and leaves every prior result valid.
- **Structured output**: the caller's zod schema is the contract; it is rendered
  to JSON Schema for the provider, validated on the way back, and repaired once.
- **Embeddings** (`AiSession.embed`) route independently — a completion provider
  may not embed at all.

## Providers

- `AnthropicProvider` — completion via forced-tool structured output; no
  embeddings.
- `OpenAiProvider` — completion via `json_schema` response format; embeddings.
- `MockProvider` — deterministic, in-process; drives every offline test.

Vendor SDK imports are confined to `src/providers/anthropic-client.ts` and
`src/providers/openai-client.ts` (the only modules importing `@anthropic-ai/sdk`
and `openai`). This is enforced by the dependency-cruiser rule
`sdk-imports-confined-to-ai-adapters` and by `test/architecture.test.ts`. API
keys enter only through those factories (env/config edge), never from graph
documents.

Offline safety: the SDK clients are injected. Production code builds a real
client via the factory; tests and offline code inject a fake implementing the
narrow client interface, so no test touches the network.

## Scripts

    pnpm --filter @meridian/ai build       # tsc -p tsconfig.json
    pnpm --filter @meridian/ai test        # vitest run (zero network)
    pnpm --filter @meridian/ai typecheck   # tsc --noEmit -p tsconfig.test.json
