const MINIMUM_NEEDLE = 16;

/**
 * Replaces each configured secret in `text`. Needles shorter than 16 characters
 * are ignored so a short field cannot blank unrelated output.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length < MINIMUM_NEEDLE) {
      continue;
    }
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

export function secretNeedles(values: readonly string[]): string[] {
  return values.filter((value) => value.length >= MINIMUM_NEEDLE);
}
