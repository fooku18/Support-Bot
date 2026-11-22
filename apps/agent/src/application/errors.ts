export class CoordinatorError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export function refuse(code = 'stale_claim'): never {
  throw new CoordinatorError(409, code);
}
