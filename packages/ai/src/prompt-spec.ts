import type { z } from 'zod';
import type { Message, TaskClass } from './types.js';

/** The rendered form of a prompt: a deterministic function of its input. */
export interface RenderedPrompt {
  readonly system?: string;
  readonly messages: readonly Message[];
}

/**
 * A versioned, deterministic prompt. Prompts are values defined in code — never
 * inline string literals at the call site (ARCHITECTURE §8.3): `render` must be
 * a pure function of `input`, and `version` must change whenever `render`'s
 * output for a fixed input changes (that is what invalidates the replay cache).
 * `schema` is the zod contract the model's structured output must satisfy.
 */
export interface PromptSpec<TInput, TOutput> {
  readonly id: string;
  readonly version: string;
  readonly taskClass: Exclude<TaskClass, 'embedding'>;
  readonly schema: z.ZodType<TOutput>;
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  readonly stopSequences?: readonly string[];
  render(input: TInput): RenderedPrompt;
}

/** Identity helper that pins the generic parameters at the definition site. */
export function definePromptSpec<TInput, TOutput>(
  spec: PromptSpec<TInput, TOutput>,
): PromptSpec<TInput, TOutput> {
  return spec;
}
