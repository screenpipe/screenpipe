// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

/**
 * Stands in for a markdown image that must not load. Markdown in this app is
 * often written by an AI or a pipe working from captured screens, pages and
 * files, so outside content can steer its image URLs, and a remote image loads
 * as soon as it renders and hands its URL to that server. The alt text fetches
 * nothing.
 */
export function ImageAltText({ alt }: { alt?: string }) {
  return alt ? <span>{alt}</span> : null;
}
