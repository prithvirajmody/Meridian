/**
 * The exchange grouping rule — the one deterministic decision that turns a flat
 * message thread into the middle level of the session → exchange → message
 * chain (§7.2.1). It is pure and total, defined for every conversation shape:
 *
 * **Rule.** Walk messages in thread order and open a new exchange at each `user`
 * turn, *unless* the current exchange is still empty. Equivalently: an exchange
 * is a `user` prompt followed by every reply up to (not including) the next
 * `user` prompt. Leading non-user messages (a system preamble, an assistant
 * greeting) form the first exchange until the first user turn arrives.
 *
 * Case coverage (the shapes 9B must handle):
 * - **empty** — no messages → no exchanges (the session node has no detail).
 * - **one-message** — a single message → one exchange holding it.
 * - **sequential** — alternating user/assistant → one exchange per user turn.
 * - **branched** — a linearized ChatGPT tree with regenerations lands all the
 *   sibling replies to a prompt inside that prompt's exchange (they follow it
 *   with no intervening user turn), so a reply can resolve to its parent within
 *   one graph.
 * - **missing-parent** — grouping ignores parent pointers entirely, so a reply
 *   whose parent is absent is grouped by position like any other message; only
 *   the reply *edge* (built later) is omitted.
 *
 * Because it depends only on role and order, the grouping is byte-stable across
 * runs and independent of which export format produced the thread (P6, §6.3).
 */
import type { RawMessage } from './format/types.js';

export function groupExchanges(messages: readonly RawMessage[]): RawMessage[][] {
  const groups: RawMessage[][] = [];
  for (const message of messages) {
    const current = groups[groups.length - 1];
    const startNew = current === undefined || (message.role === 'user' && current.length > 0);
    if (startNew) groups.push([message]);
    else current.push(message);
  }
  return groups;
}
