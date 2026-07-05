/**
 * The contract's own version (ADR-0010): semver, pre-1.0 until the Phase 9
 * freeze. Manifests declare an `apiVersion` range checked against this at
 * registration. Breaking changes only at declared checkpoints (P7, P9).
 */
export const PLUGIN_API_VERSION = '0.1.0';
