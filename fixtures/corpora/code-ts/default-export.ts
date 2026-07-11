// Anonymous default export (ADR-0028 case 1): the `default` segment.
export default function (message: string): void {
  console.log(message);
}

export const named = (): number => 1;
