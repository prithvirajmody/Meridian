/**
 * The enumerated capability kinds (ADR-0011): a closed, versioned vocabulary.
 * An unknown kind in a manifest is a manifest error — a host that "tries
 * anyway" cannot make lifecycle or security promises (ARCHITECTURE.md §14.1).
 * Phase 2 implements `domain-parser`; the rest are declared-but-dormant until
 * their consuming subsystem exists (extending this list is additive under
 * ADR-0010).
 */
export const CAPABILITY_KINDS = [
  'domain-parser',
  'abstraction-provider',
  'layout-provider',
  'view-projection',
  'ai-provider',
] as const;

export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];
