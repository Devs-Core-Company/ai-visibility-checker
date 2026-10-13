/** Thrown by commands to exit with a specific code after printing their own message. */
export class ExitError extends Error {
  constructor(
    public code: number,
    message = '',
  ) {
    super(message);
  }
}
