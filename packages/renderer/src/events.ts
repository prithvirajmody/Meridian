import type { SceneEventPayloads, Unsubscribe } from './types.js';

type Listener<E extends keyof SceneEventPayloads> = (payload: SceneEventPayloads[E]) => void;

export class SceneEvents {
  private readonly listeners = new Map<keyof SceneEventPayloads, Set<(payload: never) => void>>();

  on<E extends keyof SceneEventPayloads>(event: E, listener: Listener<E>): Unsubscribe {
    let listeners = this.listeners.get(event);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener as (payload: never) => void);
    return () => listeners?.delete(listener as (payload: never) => void);
  }

  emit<E extends keyof SceneEventPayloads>(event: E, payload: SceneEventPayloads[E]): void {
    const listeners = this.listeners.get(event);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) listener(payload as never);
  }

  clear(): void {
    this.listeners.clear();
  }
}
