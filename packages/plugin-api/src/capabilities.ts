/**
 * The enumerated capability kinds (ADR-0011): a closed, versioned vocabulary.
 * An unknown kind in a manifest is a manifest error — a host that "tries
 * anyway" cannot make lifecycle or security promises (ARCHITECTURE.md §14.1).
 * Phase 2 implements `domain-parser`; the rest are declared-but-dormant until
 * their consuming subsystem exists (extending this list is additive under
 * ADR-0010).
 *
 * `detail-resolver` is the **first post-P2 contract change** (Phase 7F,
 * ADR-0027 §DetailResolver): the code adapter materializes a function's
 * CFG/AST on drill-in. Adding an enum member changes the *runtime* surface, so
 * unlike the type-only Phase-3 additions this ships an additive **minor** bump
 * (`0.1.0` → `0.2.0`, ADR-0010) — noted here for the Phase-9 chafe report
 * (SUBPHASES §7F / §9E). The host does not route it yet (it is consumed by the
 * navigation layer in P6/P11); it is declared-but-dormant like its peers.
 */
export const CAPABILITY_KINDS = [
  'domain-parser',
  'abstraction-provider',
  'layout-provider',
  'view-projection',
  'ai-provider',
  'detail-resolver',
] as const;

export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];
