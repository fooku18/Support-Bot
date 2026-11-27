export class CoordinatorError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
