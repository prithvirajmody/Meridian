export { Circle, Shape } from './classes';
export { add } from './functions';

export function main(): void {
  const c = new Circle(2);
  void c.area();
}
