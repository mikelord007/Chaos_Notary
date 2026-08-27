export const MIN_DURATION_SECONDS = 5;
export const MAX_DURATION_SECONDS = 300;

export class InvalidDurationError extends Error {}

export function validateDuration(seconds: number): void {
  if (!Number.isInteger(seconds)) {
    throw new InvalidDurationError(`duration_seconds must be an integer, got ${seconds}`);
  }
  if (seconds < MIN_DURATION_SECONDS || seconds > MAX_DURATION_SECONDS) {
    throw new InvalidDurationError(
      `duration_seconds must be between ${MIN_DURATION_SECONDS} and ${MAX_DURATION_SECONDS}, got ${seconds}`,
    );
  }
}
