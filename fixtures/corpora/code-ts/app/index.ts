// 7E fixture — a re-export barrel. Re-exports create code:imports edges
// (module dependencies) but never new declaration nodes (ADR-0028 case 6).
export { add, twice } from './util';
export * from './models';
