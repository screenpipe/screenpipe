// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

/** Match the recorder's effective audio-off settings, including legacy stores. */
export function isMicrophoneRequired(settings: {
  disableAudio?: boolean;
  audioCaptureMode?: string;
}): boolean {
  return settings.disableAudio !== true && settings.audioCaptureMode?.toLowerCase() !== "disabled";
}
