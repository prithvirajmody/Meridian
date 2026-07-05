/**
 * API surface snapshot: the public runtime surface is a versioned contract
 * (P12) — changing this list is an intentional, reviewed act. Types are
 * checked by tsc; this pins the values.
 */
import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';

describe('@meridian/graph-core public surface', () => {
  it('exports exactly the committed names', () => {
    expect(Object.keys(core).sort()).toEqual([
      'ATTR_KEY_PATTERN',
      'COORD_SEPARATOR',
      'CORE_NAMESPACE',
      'CURRENT_FORMAT_VERSION',
      'KIND_PATTERN',
      'MeridianError',
      'RESERVED_CORE_ATTR_KEYS',
      'addEdge',
      'addGraph',
      'addNode',
      'asEdgeId',
      'asGraphId',
      'asNodeId',
      'attrValueMatchesType',
      'buildContainmentIndex',
      'canonAttrValue',
      'canonAttrs',
      'canonNumber',
      'canonProvenance',
      'containingNodeOf',
      'containmentPathOf',
      'createGraphSpace',
      'decode',
      'deriveEdgeId',
      'deriveGraphId',
      'deriveNodeId',
      'derivedRootsOf',
      'detailGraphOf',
      'encode',
      'encodeCanonical',
      'encodePretty',
      'isValidAttrValue',
      'namespaceOf',
      'nfc',
      'stats',
      'validate',
    ]);
  });
});
