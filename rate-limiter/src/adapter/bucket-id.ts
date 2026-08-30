/**
 * Encode a consumer-supplied bucket id (an IP, endpoint path, email, ...) so
 * it is safe to embed in a counter key: base64url contains only `A-Z a-z 0-9
 * - _`, which holds neither the `:` delimiter nor any glob character. That
 * makes `reset` exact — a prefix match on the encoded id can never leak into a
 * neighboring id, whatever characters the consumer's ids contain.
 */
export function encodeBucketId(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}