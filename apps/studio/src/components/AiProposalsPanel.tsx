import { useCallback, useRef } from 'react';
import { useStore } from 'zustand';
import type { StudioRuntime } from '../runtime.js';
import type { PendingProposal } from '../store.js';

export interface AiProposalsPanelProps {
  readonly runtime: StudioRuntime;
}

/**
 * The AI proposal inbox (ADR-0031). Proposals are human-in-the-loop by default:
 * each sits `pending` until accepted or rejected. Acceptance is asynchronous,
 * non-blocking, and cancellable (an in-flight accept shows a Cancel that aborts
 * before anything is written). Auto-accept is an explicit per-service opt-in,
 * never a default — the checkbox here is that opt-in.
 */
export function AiProposalsPanel({ runtime }: AiProposalsPanelProps) {
  const proposals = useStore(runtime.store, (state) => state.ai.proposals);
  const autoAccept = useStore(runtime.store, (state) => state.ai.autoAccept);

  // One AbortController per in-flight accept, so Cancel can abort it.
  const inflight = useRef(new Map<string, AbortController>());

  const onAccept = useCallback(
    (id: string) => {
      const controller = new AbortController();
      inflight.current.set(id, controller);
      void runtime.session.aiTrust.accept(id, controller.signal).finally(() => {
        inflight.current.delete(id);
      });
    },
    [runtime],
  );

  const onCancel = useCallback((id: string) => {
    inflight.current.get(id)?.abort();
    inflight.current.delete(id);
  }, []);

  const onReject = useCallback(
    (id: string) => {
      inflight.current.get(id)?.abort();
      inflight.current.delete(id);
      runtime.session.aiTrust.reject(id);
    },
    [runtime],
  );

  const services = [...new Set(proposals.map((p) => p.service))].sort();

  if (proposals.length === 0) {
    return (
      <section className="ai-proposals" aria-label="AI proposals" data-testid="ai-proposals">
        <p className="eyebrow">AI proposals</p>
        <p className="muted" data-testid="ai-proposals-empty">
          No pending AI proposals.
        </p>
      </section>
    );
  }

  return (
    <section className="ai-proposals" aria-label="AI proposals" data-testid="ai-proposals">
      <p className="eyebrow">
        AI proposals <span data-testid="ai-proposals-count">({proposals.length})</span>
      </p>

      {services.map((service) => {
        const rule = autoAccept[service] ?? { enabled: false };
        return (
          <label key={`auto-${service}`} className="auto-accept" data-testid={`auto-accept-${service}`}>
            <input
              type="checkbox"
              checked={rule.enabled}
              data-testid={`auto-accept-toggle-${service}`}
              onChange={(event) =>
                runtime.session.aiTrust.setAutoAccept(service, { enabled: event.currentTarget.checked })
              }
            />
            Auto-accept <strong>{service}</strong> (opt-in)
          </label>
        );
      })}

      <ul className="proposal-list">
        {proposals.map((proposal) => (
          <ProposalRow
            key={proposal.id}
            proposal={proposal}
            onAccept={onAccept}
            onReject={onReject}
            onCancel={onCancel}
          />
        ))}
      </ul>
    </section>
  );
}

interface ProposalRowProps {
  readonly proposal: PendingProposal;
  readonly onAccept: (id: string) => void;
  readonly onReject: (id: string) => void;
  readonly onCancel: (id: string) => void;
}

function ProposalRow({ proposal, onAccept, onReject, onCancel }: ProposalRowProps) {
  const accepting = proposal.status === 'accepting';
  return (
    <li className="proposal" data-testid={`proposal-${proposal.id}`} data-status={proposal.status}>
      <div className="proposal-head">
        <span className="ai-dot" aria-hidden="true" />
        <span className="proposal-service">{proposal.service}</span>
        <span className="proposal-title">{proposal.title}</span>
        {proposal.minConfidence !== null ? (
          <span className="proposal-confidence">conf ≥ {proposal.minConfidence.toFixed(2)}</span>
        ) : null}
      </div>
      {proposal.status === 'failed' && proposal.errors.length > 0 ? (
        <p className="proposal-errors" data-testid={`proposal-errors-${proposal.id}`}>
          {proposal.errors.join('; ')}
        </p>
      ) : null}
      <div className="proposal-actions">
        {accepting ? (
          <button
            type="button"
            data-testid={`proposal-cancel-${proposal.id}`}
            onClick={() => onCancel(proposal.id)}
          >
            Cancel…
          </button>
        ) : (
          <>
            <button
              type="button"
              className="accept"
              data-testid={`proposal-accept-${proposal.id}`}
              onClick={() => onAccept(proposal.id)}
            >
              Accept
            </button>
            <button
              type="button"
              className="reject"
              data-testid={`proposal-reject-${proposal.id}`}
              onClick={() => onReject(proposal.id)}
            >
              Reject
            </button>
          </>
        )}
      </div>
    </li>
  );
}
