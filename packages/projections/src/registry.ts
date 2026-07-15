import type { ProjectionModel } from '@meridian/view-model';
import type { ViewProjection } from './contracts.js';

export interface RankedProjection {
  readonly projection: ViewProjection;
  readonly suitability: number;
}

function normalizedSuitability(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Ordered registry shared by built-ins and structurally compatible plugins. */
export class ProjectionRegistry {
  private readonly projections = new Map<string, ViewProjection>();

  constructor(projections: Iterable<ViewProjection> = []) {
    for (const projection of projections) this.register(projection);
  }

  register(projection: ViewProjection): void {
    if (projection.id.trim().length === 0) {
      throw new TypeError('projections: projection id must not be empty');
    }
    if (this.projections.has(projection.id)) {
      throw new Error(`projections: duplicate projection id "${projection.id}"`);
    }
    this.projections.set(projection.id, projection);
  }

  get(id: string): ViewProjection | undefined {
    return this.projections.get(id);
  }

  list(): readonly ViewProjection[] {
    return [...this.projections.values()];
  }

  ranked(model: ProjectionModel): readonly RankedProjection[] {
    return this.list()
      .map((projection) => ({
        projection,
        suitability: normalizedSuitability(projection.suitability(model)),
      }))
      .sort(
        (left, right) =>
          right.suitability - left.suitability ||
          left.projection.label.localeCompare(right.projection.label) ||
          left.projection.id.localeCompare(right.projection.id),
      );
  }
}
