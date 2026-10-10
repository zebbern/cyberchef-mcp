/** Caller-facing failure: unknown name, excluded operation, or network switch. */
export class ChefInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChefInputError";
  }
}

/** The worker was stopped because the tool timeout elapsed. */
export class ChefTimeoutError extends Error {
  readonly workerTerminated = true;

  constructor(timeoutMs: number) {
    super(`CyberChef worker timed out after ${timeoutMs}ms and was terminated.`);
    this.name = "ChefTimeoutError";
  }
}
