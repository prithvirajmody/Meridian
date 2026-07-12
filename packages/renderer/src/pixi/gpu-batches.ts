import {
  Buffer,
  BufferUsage,
  Geometry,
  Mesh,
  Shader,
  type Container,
} from 'pixi.js';
import type { RenderModel } from '@meridian/view-model';
import { ZERO_SIZE_MARKER_CSS_PX } from '../picking/hit-test.js';

export interface VisiblePrimitiveBatch {
  readonly batchIndex: number;
  readonly indices: Uint32Array;
}

export interface EdgeSegmentData {
  /** `[x1,y1,x2,y2]` per segment. */
  readonly coordinates: Float64Array;
  /** Original RenderModel edge index per segment. */
  readonly edgeIndices: Uint32Array;
}

const QUAD = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const LINE_QUAD = new Float32Array([0, -0.5, 1, -0.5, 1, 0.5, 0, 0.5]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

const NODE_VERTEX = `
precision highp float;
attribute vec2 aPosition;
attribute vec4 aInstanceRect;
attribute vec4 aInstanceColor;
attribute float aInstanceFlags;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;
varying vec4 vColor;

void main(void) {
  vec2 world = aInstanceRect.xy + aPosition * aInstanceRect.zw;
  vec3 projected = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(world, 1.0);
  gl_Position = vec4(projected.xy, 0.0, 1.0);
  float selected = mod(aInstanceFlags, 2.0);
  vColor = vec4(mix(aInstanceColor.rgb, vec3(1.0), selected * 0.32), aInstanceColor.a) * uColor;
}
`;

const EDGE_VERTEX = `
precision highp float;
attribute vec2 aPosition;
attribute vec4 aInstanceEnds;
attribute vec4 aInstanceColor;
attribute float aInstanceFlags;
attribute float aInstanceWidth;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;
varying vec4 vColor;

void main(void) {
  vec2 start = aInstanceEnds.xy;
  vec2 finish = aInstanceEnds.zw;
  vec2 delta = finish - start;
  float lengthValue = max(length(delta), 0.000001);
  vec2 normal = vec2(-delta.y, delta.x) / lengthValue;
  vec2 world = mix(start, finish, aPosition.x) + normal * aPosition.y * aInstanceWidth;
  vec3 projected = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(world, 1.0);
  gl_Position = vec4(projected.xy, 0.0, 1.0);
  float selected = mod(aInstanceFlags, 2.0);
  vColor = vec4(mix(aInstanceColor.rgb, vec3(0.98, 0.78, 0.28), selected), aInstanceColor.a) * uColor;
}
`;

const FRAGMENT = `
precision mediump float;
varying vec4 vColor;

void main(void) {
  gl_FragColor = vColor;
}
`;

function hashColor(value: string): readonly [number, number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex !== null) {
    const packed = Number.parseInt(hex[1]!, 16);
    return [((packed >> 16) & 255) / 255, ((packed >> 8) & 255) / 255, (packed & 255) / 255, 1];
  }

  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return [
    0.28 + ((hash >>> 16) & 127) / 255,
    0.32 + ((hash >>> 8) & 111) / 255,
    0.38 + (hash & 95) / 255,
    1,
  ];
}

function colorById(
  keys: readonly string[],
  colorIds: Uint16Array,
  index: number,
): readonly [number, number, number, number] {
  return hashColor(keys[colorIds[index] ?? 0] ?? '#8291a8');
}

interface BatchBuffers {
  readonly geometry: Geometry;
  readonly mesh: Mesh<Geometry, Shader>;
  readonly values: Float32Array;
  readonly colors: Float32Array;
  readonly flags: Float32Array;
  readonly widths?: Float32Array;
  readonly valueBuffer: Buffer;
  readonly colorBuffer: Buffer;
  readonly flagBuffer: Buffer;
  readonly widthBuffer?: Buffer;
}

function dynamicBuffer(data: Float32Array, label: string): Buffer {
  return new Buffer({
    data,
    label,
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    shrinkToFit: false,
  });
}

function createNodeBatch(capacity: number, shader: Shader, index: number): BatchBuffers {
  const values = new Float32Array(capacity * 4);
  const colors = new Float32Array(capacity * 4);
  const flags = new Float32Array(capacity);
  const valueBuffer = dynamicBuffer(values, `meridian-node-rects-${index}`);
  const colorBuffer = dynamicBuffer(colors, `meridian-node-colors-${index}`);
  const flagBuffer = dynamicBuffer(flags, `meridian-node-flags-${index}`);
  const geometry = new Geometry({
    label: `meridian-node-batch-${index}`,
    attributes: {
      aPosition: { buffer: QUAD, format: 'float32x2' },
      aInstanceRect: { buffer: valueBuffer, format: 'float32x4', instance: true },
      aInstanceColor: { buffer: colorBuffer, format: 'float32x4', instance: true },
      aInstanceFlags: { buffer: flagBuffer, format: 'float32', instance: true },
    },
    indexBuffer: QUAD_INDICES,
    instanceCount: 0,
  });
  const mesh = new Mesh({ geometry, shader });
  mesh.visible = false;
  return { geometry, mesh, values, colors, flags, valueBuffer, colorBuffer, flagBuffer };
}

function createEdgeBatch(capacity: number, shader: Shader, index: number): BatchBuffers {
  const values = new Float32Array(capacity * 4);
  const colors = new Float32Array(capacity * 4);
  const flags = new Float32Array(capacity);
  const widths = new Float32Array(capacity);
  const valueBuffer = dynamicBuffer(values, `meridian-edge-ends-${index}`);
  const colorBuffer = dynamicBuffer(colors, `meridian-edge-colors-${index}`);
  const flagBuffer = dynamicBuffer(flags, `meridian-edge-flags-${index}`);
  const widthBuffer = dynamicBuffer(widths, `meridian-edge-widths-${index}`);
  const geometry = new Geometry({
    label: `meridian-edge-batch-${index}`,
    attributes: {
      aPosition: { buffer: LINE_QUAD, format: 'float32x2' },
      aInstanceEnds: { buffer: valueBuffer, format: 'float32x4', instance: true },
      aInstanceColor: { buffer: colorBuffer, format: 'float32x4', instance: true },
      aInstanceFlags: { buffer: flagBuffer, format: 'float32', instance: true },
      aInstanceWidth: { buffer: widthBuffer, format: 'float32', instance: true },
    },
    indexBuffer: QUAD_INDICES,
    instanceCount: 0,
  });
  const mesh = new Mesh({ geometry, shader });
  mesh.visible = false;
  return {
    geometry,
    mesh,
    values,
    colors,
    flags,
    widths,
    valueBuffer,
    colorBuffer,
    flagBuffer,
    widthBuffer,
  };
}

function destroyBatch(batch: BatchBuffers): void {
  batch.mesh.destroy();
  batch.geometry.destroy(true);
}

function writeColor(
  target: Float32Array,
  offset: number,
  color: readonly number[],
  alpha = 1,
): void {
  // Premultiplied: Pixi's normal blend mode expects premultiplied sources, so
  // a straight alpha in the color attribute would brighten fading primitives.
  target[offset] = color[0]! * alpha;
  target[offset + 1] = color[1]! * alpha;
  target[offset + 2] = color[2]! * alpha;
  target[offset + 3] = color[3]! * alpha;
}

/** Transition-frame opacity for one primitive (ADR-0023); absent lane ⇒ 1. */
function laneAlpha(lane: Float32Array | undefined, index: number): number {
  const value = lane?.[index];
  if (value === undefined) return 1;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Owns only bounded mesh batches; never one display object per graph element. */
export class PixiGpuBatches {
  private readonly nodeShader = Shader.from({ gl: { vertex: NODE_VERTEX, fragment: FRAGMENT } });
  private readonly edgeShader = Shader.from({ gl: { vertex: EDGE_VERTEX, fragment: FRAGMENT } });
  private nodeBatches: BatchBuffers[] = [];
  private edgeBatches: BatchBuffers[] = [];
  private readonly maxBatchSize: number;

  constructor(maxBatchSize: number) {
    this.maxBatchSize = maxBatchSize;
  }

  configure(stage: Container, nodeBatchCount: number, edgeBatchCount: number): void {
    if (this.nodeBatches.length === nodeBatchCount && this.edgeBatches.length === edgeBatchCount) {
      return;
    }
    stage.removeChildren();
    for (const batch of this.nodeBatches) destroyBatch(batch);
    for (const batch of this.edgeBatches) destroyBatch(batch);
    this.edgeBatches = Array.from({ length: edgeBatchCount }, (_, index) =>
      createEdgeBatch(this.maxBatchSize, this.edgeShader, index),
    );
    this.nodeBatches = Array.from({ length: nodeBatchCount }, (_, index) =>
      createNodeBatch(this.maxBatchSize, this.nodeShader, index),
    );
    for (const batch of this.edgeBatches) stage.addChild(batch.mesh);
    for (const batch of this.nodeBatches) stage.addChild(batch.mesh);
  }

  updateNodes(
    model: RenderModel,
    visible: readonly VisiblePrimitiveBatch[],
    cameraScale: number,
  ): number {
    for (const batch of this.nodeBatches) {
      batch.mesh.visible = false;
      batch.geometry.instanceCount = 0;
    }
    let bytes = 0;
    for (const group of visible) {
      const batch = this.nodeBatches[group.batchIndex];
      if (batch === undefined) continue;
      const count = Math.min(group.indices.length, this.maxBatchSize);
      for (let slot = 0; slot < count; slot++) {
        const nodeIndex = group.indices[slot]!;
        const source = nodeIndex * 4;
        const target = slot * 4;
        const x = model.nodeRects[source]!;
        const y = model.nodeRects[source + 1]!;
        const width = model.nodeRects[source + 2]!;
        const height = model.nodeRects[source + 3]!;
        if (width === 0 && height === 0) {
          // Layout truth remains a point. Only the GPU upload expands it, in
          // inverse camera units, so the displayed footprint is exactly the
          // same 6x6 CSS-pixel marker that ADR-0021 picking tests.
          const markerWorldSize = ZERO_SIZE_MARKER_CSS_PX / cameraScale;
          batch.values[target] = x - markerWorldSize / 2;
          batch.values[target + 1] = y - markerWorldSize / 2;
          batch.values[target + 2] = markerWorldSize;
          batch.values[target + 3] = markerWorldSize;
        } else {
          batch.values[target] = x;
          batch.values[target + 1] = y;
          batch.values[target + 2] = width;
          batch.values[target + 3] = height;
        }
        writeColor(
          batch.colors,
          target,
          colorById(model.nodeColorKeys, model.nodeColorIds, nodeIndex),
          laneAlpha(model.nodeAlphas, nodeIndex),
        );
        batch.flags[slot] = model.nodeFlags[nodeIndex] ?? 0;
      }
      batch.valueBuffer.update(count * 4 * Float32Array.BYTES_PER_ELEMENT);
      batch.colorBuffer.update(count * 4 * Float32Array.BYTES_PER_ELEMENT);
      batch.flagBuffer.update(count * Float32Array.BYTES_PER_ELEMENT);
      batch.geometry.instanceCount = count;
      batch.mesh.visible = count > 0;
      bytes += count * 9 * Float32Array.BYTES_PER_ELEMENT;
    }
    return bytes;
  }

  updateEdges(
    model: RenderModel,
    segments: EdgeSegmentData,
    visible: readonly VisiblePrimitiveBatch[],
    cameraScale: number,
  ): number {
    for (const batch of this.edgeBatches) {
      batch.mesh.visible = false;
      batch.geometry.instanceCount = 0;
    }
    let bytes = 0;
    for (const group of visible) {
      const batch = this.edgeBatches[group.batchIndex];
      if (batch === undefined || batch.widths === undefined || batch.widthBuffer === undefined) continue;
      const count = Math.min(group.indices.length, this.maxBatchSize);
      for (let slot = 0; slot < count; slot++) {
        const segmentIndex = group.indices[slot]!;
        const source = segmentIndex * 4;
        const edgeIndex = segments.edgeIndices[segmentIndex];
        if (edgeIndex === undefined) continue;
        const target = slot * 4;
        batch.values[target] = segments.coordinates[source]!;
        batch.values[target + 1] = segments.coordinates[source + 1]!;
        batch.values[target + 2] = segments.coordinates[source + 2]!;
        batch.values[target + 3] = segments.coordinates[source + 3]!;
        writeColor(
          batch.colors,
          target,
          colorById(model.edgeColorKeys, model.edgeColorIds, edgeIndex),
          laneAlpha(model.edgeAlphas, edgeIndex),
        );
        batch.flags[slot] = model.edgeFlags[edgeIndex] ?? 0;
        batch.widths[slot] = 1.25 / cameraScale;
      }
      batch.valueBuffer.update(count * 4 * Float32Array.BYTES_PER_ELEMENT);
      batch.colorBuffer.update(count * 4 * Float32Array.BYTES_PER_ELEMENT);
      batch.flagBuffer.update(count * Float32Array.BYTES_PER_ELEMENT);
      batch.widthBuffer.update(count * Float32Array.BYTES_PER_ELEMENT);
      batch.geometry.instanceCount = count;
      batch.mesh.visible = count > 0;
      bytes += count * 10 * Float32Array.BYTES_PER_ELEMENT;
    }
    return bytes;
  }

  destroy(): void {
    for (const batch of this.nodeBatches) destroyBatch(batch);
    for (const batch of this.edgeBatches) destroyBatch(batch);
    this.nodeBatches = [];
    this.edgeBatches = [];
    this.nodeShader.destroy(true);
    this.edgeShader.destroy(true);
  }
}
