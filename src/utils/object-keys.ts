/**
 * Helpers for using untrusted strings (node names, parameter keys, output
 * names) as keys on plain objects.
 */

/** Keys that are never accepted as object path segments or map keys. */
export const RESERVED_OBJECT_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Checks the key as property access would see it (non-strings are converted to strings). */
export function isReservedObjectKey(key: unknown): boolean {
  return key !== null && key !== undefined && typeof key !== 'symbol' && RESERVED_OBJECT_KEYS.has(String(key));
}

/** Own-property check that ignores keys inherited from Object.prototype. */
export function hasOwnKey(obj: unknown, key: PropertyKey): boolean {
  return obj !== null && obj !== undefined && Object.prototype.hasOwnProperty.call(obj, key);
}
