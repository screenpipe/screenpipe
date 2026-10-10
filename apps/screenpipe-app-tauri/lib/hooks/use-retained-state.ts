// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import {
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

// Last committed value per key, kept for the life of this webview.
const retained = new Map<string, unknown>();
// Counts clears. A mount from before the latest clear stops saving: it would
// only save the values that change afterwards, and the next mount would pair
// those with defaults for the rest (a range's activities under another range).
let generation = 0;

/**
 * `useState` whose value outlives the component: the next mount under the
 * same key starts from the last committed value instead of `initial`.
 *
 * The home sections unmount whenever the user switches tabs. With plain
 * `useState`, every return started from the loading state and flashed a
 * skeleton or a wrong empty state ("No skills yet", "0 total") for the moment
 * the local API takes to answer. Retaining the fetched data shows what was on
 * screen last time while the mount's own fetch quietly refreshes it.
 *
 * Retain data and the inputs that select it (a search query, a range), not
 * transient UI such as an open dialog. Don't retain a loading flag: after a
 * failed load it would let the next visit pass empty data off as "nothing
 * here". Start loading from a value set only on success instead. Keys share
 * one namespace per window, so prefix them with the component, and never
 * change a key while mounted.
 */
export function useRetainedState<T>(
  key: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() =>
    retained.has(key)
      ? (retained.get(key) as T)
      : initial instanceof Function
        ? initial()
        : initial,
  );
  const [mountGeneration] = useState(generation);
  useEffect(() => {
    if (mountGeneration === generation) retained.set(key, value);
  }, [key, value, mountGeneration]);
  return [value, setValue];
}

/**
 * Change a retained value while its section is closed, so the next mount
 * starts from the changed value. An open section keeps its own state.
 */
export function updateRetainedState<T>(key: string, update: (value: T) => T) {
  if (retained.has(key)) retained.set(key, update(retained.get(key) as T));
}

/**
 * Forget every retained value in this window, including what open sections
 * would save later, so each section's next mount starts from `initial`.
 * Tests call this between cases; after a data deletion, use
 * `forgetRetainedStateEverywhere` so every window forgets.
 */
export function clearRetainedState() {
  retained.clear();
  generation += 1;
}
