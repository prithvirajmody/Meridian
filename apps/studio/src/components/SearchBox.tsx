import { useState } from 'react';
import type { NodeId } from '@meridian/view-model';
import { useStore } from 'zustand';
import type { StudioRuntime } from '../runtime.js';

export interface SearchBoxProps {
  readonly runtime: StudioRuntime;
}

interface Hit {
  readonly node: string;
  readonly score: number;
  readonly label: string;
}

/**
 * Search-and-fly-to (ADR-0025): queries the P1 label-token index through the
 * 6C search port, scoped to the current context; selecting a hit flies the
 * camera and sets `focus` — it never drills.
 */
export function SearchBox({ runtime }: SearchBoxProps) {
  const nav = useStore(runtime.store, (state) => state.nav);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<readonly Hit[]>([]);
  if (nav === null) return null;

  const run = (value: string): void => {
    setQuery(value);
    const navigator = runtime.navigator();
    setHits(navigator === null || value.trim() === '' ? [] : navigator.search(value));
  };

  const choose = (hit: Hit): void => {
    runtime.navigator()?.flyTo(hit.node as NodeId);
    setQuery('');
    setHits([]);
  };

  return (
    <div className="search-box" data-testid="search-box">
      <input
        type="search"
        value={query}
        placeholder="Search labels…"
        aria-label="Search node labels"
        data-testid="search-input"
        onChange={(event) => run(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && hits.length > 0) choose(hits[0]!);
          if (event.key === 'Escape') run('');
        }}
      />
      {hits.length > 0 ? (
        <ul className="search-results" data-testid="search-results">
          {hits.slice(0, 8).map((hit) => (
            <li key={hit.node}>
              <button type="button" data-testid="search-hit" onClick={() => choose(hit)}>
                {hit.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
