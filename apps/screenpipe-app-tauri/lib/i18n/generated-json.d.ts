// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// The canonical dev/build entry points create this ignored artifact. Keep type
// checking available before a fresh checkout has prepared its first snapshot.
declare module "@/lib/i18n/generated.json" {
  const snapshot: unknown;
  export default snapshot;
}
