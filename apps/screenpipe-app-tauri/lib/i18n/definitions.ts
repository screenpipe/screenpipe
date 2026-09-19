// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { decodeOptions, useMessages } from "gt-react";

// Source definitions are immutable. Keep their identity stable within a locale
// so consumers can use them as props/effect dependencies without restarting work.
const resolvedDefinitions = new WeakMap<ReturnType<typeof useMessages>, WeakMap<object, unknown>>();

/** Resolve only explicitly marked source definitions, never user content.
 * Callers pass owned option/search/menu definitions, keeping IDs and values
 * unchanged. Resolving during render also updates settings search on a switch.
 */
export function localizeDefinitions<T>(value: T, message: ReturnType<typeof useMessages>): T {
  if (typeof value === "string") {
    // Compiled msg() values carry source/hash metadata. Unmarked strings,
    // including IDs, prompts and user content, are never translation inputs.
    return (decodeOptions(value)?.$_source ? message(value) : value) as T;
  }
  if (!value || typeof value !== "object" || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) return value;
  let cache = resolvedDefinitions.get(message);
  if (!cache) { cache = new WeakMap(); resolvedDefinitions.set(message, cache); }
  if (cache.has(value)) return cache.get(value) as T;
  const resolved = Array.isArray(value)
    ? value.map(item => localizeDefinitions(item, message))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, localizeDefinitions(item, message)]));
  cache.set(value, resolved);
  return resolved as T;
}
