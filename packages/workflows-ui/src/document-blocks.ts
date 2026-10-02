// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
export type AddedDocumentBlock = {
  id: string;
  type: "text" | "heading" | "image" | "video" | "divider";
  text: string;
  url?: string;
};
export type DocumentLayout = { order: string[]; added: AddedDocumentBlock[] };
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[\w:/-]{1,120}$/.test(value);
export function safeBlockMediaUrl(value: string): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      value.length <= 2048
    );
  } catch {
    return false;
  }
}
export function parseDocumentLayout(value: unknown): DocumentLayout {
  const layout = value as DocumentLayout;
  if (
    !layout ||
    !Array.isArray(layout.order) ||
    layout.order.length > 400 ||
    !layout.order.every(id) ||
    new Set(layout.order).size !== layout.order.length ||
    !Array.isArray(layout.added) ||
    layout.added.length > 120 ||
    !layout.added.every(
      (block) =>
        block &&
        id(block.id) &&
        block.id.startsWith("custom/") &&
        ["text", "heading", "image", "video", "divider"].includes(block.type) &&
        typeof block.text === "string" &&
        block.text.length <= 8000 &&
        (block.url === undefined ||
          (typeof block.url === "string" && safeBlockMediaUrl(block.url))),
    ) ||
    new Set(layout.added.map((block) => block.id)).size !== layout.added.length
  )
    throw new Error(
      "The saved document blocks are invalid. Your saved SOP is unchanged.",
    );
  return {
    order: [...layout.order],
    added: layout.added.map(({ id, type, text, url }) => ({
      id,
      type,
      text,
      ...(url === undefined ? {} : { url }),
    })),
  };
}
/** Order stores references, never another copy of the SOP or its captures. */
export function orderedBlockIds(
  defaults: string[],
  layout?: DocumentLayout,
): string[] {
  const available = new Set([
    ...defaults,
    ...(layout?.added.map((block) => block.id) ?? []),
  ]);
  const order = [...(layout?.order ?? [])].filter((key) => available.has(key));
  // Insert newly available built-in blocks beside their default neighbours. In
  // particular, a completed video appears first unless the user already moved it.
  for (let i = 0; i < defaults.length; i++) {
    const key = defaults[i];
    if (order.includes(key)) continue;
    if (i === 0) { order.unshift(key); continue; }
    const next = defaults.slice(i + 1).find((id) => order.includes(id));
    if (next) order.splice(order.indexOf(next), 0, key);
    else order.push(key);
  }
  for (const block of layout?.added ?? [])
    if (!order.includes(block.id)) order.push(block.id);
  return order;
}
