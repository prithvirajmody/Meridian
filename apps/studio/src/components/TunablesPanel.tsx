/**
 * The 6E tunable-constants panel (ADR-0023/0024/0025 "6E panel"): a debug-only
 * React island (behind `?debug=1`, alongside the FPS/heap HUD) that edits the
 * *session copy* of the navigation tunables in the Zustand store. The
 * navigator reads that copy at each verb/plan, so an edit takes effect on the
 * next transition without reload; "Reset to ADR defaults" restores the
 * canonical frozen `NAV_TUNABLE_DEFAULTS`. React only (ADR-0022) — no pixi,
 * no renderer imports; the panel never touches the canvas.
 */
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { EASING, NAV_TUNABLE_DEFAULTS, type NavTunables } from '@meridian/navigation';
import { StudioStoreCommands, type StudioStore } from '../store.js';
import { TUNABLE_SPECS, type TunableSpec } from '../tunable-specs.js';

export interface TunablesPanelProps {
  readonly store: StudioStore;
}

function formatValue(value: number): string {
  // Round-trippable, no float noise (0.30000000000000004 → "0.3").
  return String(Number(value.toPrecision(12)));
}

interface TunableRowProps {
  readonly spec: TunableSpec;
  readonly value: number;
  readonly onCommit: (key: keyof NavTunables, value: number) => void;
}

function TunableRow({ spec, value, onCommit }: TunableRowProps) {
  const [text, setText] = useState(() => formatValue(value));

  // External writes (reset, another session actor) re-sync the input text.
  useEffect(() => {
    setText(formatValue(value));
  }, [value]);

  const isDefault = value === NAV_TUNABLE_DEFAULTS[spec.key];
  return (
    <label className="tunable-row" title={`${spec.adr} · default ${formatValue(NAV_TUNABLE_DEFAULTS[spec.key])} ${spec.unit}`}>
      <span className="tunable-name">
        {spec.label}
        {isDefault ? null : <em aria-label="edited"> *</em>}
      </span>
      <input
        type="number"
        inputMode="decimal"
        data-testid={`tunable-${spec.key}`}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={text}
        onChange={(event) => {
          const raw = event.currentTarget.value;
          setText(raw);
          const parsed = Number(raw);
          if (raw.trim() !== '' && Number.isFinite(parsed)) onCommit(spec.key, parsed);
        }}
        onBlur={() => setText(formatValue(value))}
      />
      <span className="tunable-unit">{spec.unit}</span>
    </label>
  );
}

export function TunablesPanel({ store }: TunablesPanelProps) {
  const tunables = useStore(store, (state) => state.tunables);
  const commands = new StudioStoreCommands(store);
  const dirty = TUNABLE_SPECS.some((spec) => tunables[spec.key] !== NAV_TUNABLE_DEFAULTS[spec.key]);

  return (
    <details className="tunables-panel" data-testid="tunables-panel">
      <summary data-testid="tunables-summary">
        Tunables{dirty ? ' *' : ''}
      </summary>
      <div className="tunables-body">
        {TUNABLE_SPECS.map((spec) => (
          <TunableRow
            key={spec.key}
            spec={spec}
            value={tunables[spec.key]}
            onCommit={(key, value) => commands.setTunable(key, value)}
          />
        ))}
        <div className="tunable-row tunable-static" title="ADR-0023: one shared easing — a decision, not a knob">
          <span className="tunable-name">EASING</span>
          <span data-testid="tunable-easing">{EASING}</span>
          <span className="tunable-unit">view-only</span>
        </div>
        <button
          type="button"
          data-testid="tunables-reset"
          disabled={!dirty}
          onClick={() => commands.resetTunables()}
        >
          Reset to ADR defaults
        </button>
        <p className="tunables-note">Edits apply from the next transition.</p>
      </div>
    </details>
  );
}
