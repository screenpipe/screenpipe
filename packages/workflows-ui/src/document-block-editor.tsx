// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useRef, useState, type ReactNode } from "react";
import {
  GripVertical,
  Plus,
  Type,
  Heading2,
  Image,
  Minus,
  ArrowUp,
  ArrowDown,
  Trash2,
} from "lucide-react";
import { InlineText } from "./inline-text";
import { WorkflowRichText } from "./rich-text";
import {
  orderedBlockIds,
  safeBlockMediaUrl,
  type DocumentLayout,
  type AddedDocumentBlock,
} from "./document-blocks";
import styles from "./document-block-editor.module.css";
export type DocumentBlock = { id: string; label: string; content: ReactNode };
export function DocumentBlockEditor({
  blocks,
  layout,
  onChange,
  disabled = false,
}: {
  blocks: DocumentBlock[];
  layout?: DocumentLayout;
  onChange: (next: DocumentLayout) => void;
  disabled?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const dragging = useRef<string | null>(null);
  const [drop, setDrop] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const ids = orderedBlockIds(
    blocks.map((block) => block.id),
    layout,
  );
  const added = layout?.added ?? [];
  const current = { order: ids, added };
  function focus(id: string, edit = false) {
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLElement>(
          `[data-block-id="${id}"] ${edit ? ':is(textarea, [contenteditable="true"], input)' : "[data-block-handle]"}`,
        )
        ?.focus(),
    );
  }
  function move(id: string, index: number) {
    const from = ids.indexOf(id);
    if (
      disabled ||
      from < 0 ||
      index < 0 ||
      index >= ids.length ||
      from === index
    )
      return;
    const order = [...ids];
    order.splice(from, 1);
    order.splice(index, 0, id);
    onChange({ ...current, order });
    setAnnouncement(`Block moved to position ${index + 1}`);
    focus(id);
  }
  function add(after: string, type: AddedDocumentBlock["type"]) {
    if (disabled || added.length >= 120) return;
    const id = `custom/${crypto.randomUUID()}`;
    const order = [...ids];
    order.splice(ids.indexOf(after) + 1, 0, id);
    onChange({ order, added: [...added, { id, type, text: "" }] });
    setMenu(null);
    focus(id, true);
  }
  return (
    <div
      ref={root}
      onKeyDown={event => {
        if (event.key === "Escape" && menu) {
          event.stopPropagation();
          const id = menu.startsWith("move/") ? menu.slice(5) : menu;
          setMenu(null); focus(id);
        }
      }}
      className={styles.document}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          setMenu(null);
      }}
    >
      <span className={styles.srOnly} role="status">
        {announcement}
      </span>
      {ids.map((id, index) => {
        const block = blocks.find((block) => block.id === id);
        const extra = added.find((block) => block.id === id);
        const label = block?.label ?? `${extra?.type ?? "Content"} block`;
        return (
          <section
            key={id}
            data-block-id={id}
            aria-label={`${label} block`}
            className={`${styles.block} ${drop === id ? styles.drop : ""}`}
            onDragOverCapture={(event) => {
              if (dragging.current && !disabled) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDrop(id);
              }
            }}
            onDropCapture={(event) => {
              if (!dragging.current) return;
              event.preventDefault();
              event.stopPropagation();
              move(dragging.current, index);
              dragging.current = null;
              setDrop(null);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node))
                setDrop(null);
            }}
          >
            <div className={styles.controls}>
              <button
                type="button"
                disabled={disabled || added.length >= 120}
                aria-label={`Add block after ${label}`}
                aria-expanded={menu === id}
                onClick={() => setMenu(menu === id ? null : id)}
              >
                <Plus size={16} />
              </button>
              <button
                type="button"
                disabled={disabled}
                data-block-handle
                draggable={!disabled}
                aria-label={`Move ${label}`}
                title="Drag to move. Alt + arrow keys also work."
                onDragStart={(event) => {
                  dragging.current = id;
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData(
                    "application/x-screenpipe-workflow",
                    id,
                  );
                  setMenu(null);
                }}
                onDragEnd={() => {
                  dragging.current = null;
                  setDrop(null);
                }}
                onKeyDown={(event) => {
                  if (
                    event.altKey &&
                    ["ArrowUp", "ArrowDown"].includes(event.key)
                  ) {
                    event.preventDefault();
                    move(id, index + (event.key === "ArrowUp" ? -1 : 1));
                  }
                }}
                onClick={() =>
                  setMenu(menu === `move/${id}` ? null : `move/${id}`)
                }
              >
                <GripVertical size={16} />
              </button>
            </div>
            {menu === id && (
              <div
                className={styles.menu}
                role="group"
                aria-label="Insert block"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setMenu(null);
                    focus(id);
                  }
                }}
              >
                {(
                  [
                    ["text", Type, "Text"],
                    ["heading", Heading2, "Heading"],
                    ["image", Image, "Image"],
                    ["divider", Minus, "Divider"],
                  ] as const
                ).map(([type, Icon, title]) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => add(id, type)}
                  >
                    <Icon size={16} />
                    {title}
                  </button>
                ))}
              </div>
            )}
            {menu === `move/${id}` && (
              <div
                className={styles.menu}
                role="group"
                aria-label="Move block"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setMenu(null);
                    focus(id);
                  }
                }}
              >
                <button
                  disabled={index === 0}
                  onClick={() => {
                    move(id, index - 1);
                    setMenu(null);
                  }}
                >
                  <ArrowUp size={16} />
                  Move up
                </button>
                <button
                  disabled={index === ids.length - 1}
                  onClick={() => {
                    move(id, index + 1);
                    setMenu(null);
                  }}
                >
                  <ArrowDown size={16} />
                  Move down
                </button>
                {extra && (
                  <button
                    onClick={() => {
                      onChange({
                        order: ids.filter((key) => key !== id),
                        added: added.filter((block) => block.id !== id),
                      });
                      setMenu(null);
                      focus(ids[Math.max(0, index - 1)]);
                    }}
                  >
                    <Trash2 size={16} />
                    Delete block
                  </button>
                )}
              </div>
            )}
            {block?.content ??
              (extra && (
                <AddedBlock
                  block={extra}
                  change={(patch) =>
                    onChange({
                      ...current,
                      added: added.map((block) =>
                        block.id === id ? { ...block, ...patch } : block,
                      ),
                    })
                  }
                />
              ))}
          </section>
        );
      })}
    </div>
  );
}
function AddedBlock({
  block,
  change,
}: {
  block: AddedDocumentBlock;
  change: (patch: Partial<AddedDocumentBlock>) => void;
}) {
  const [url, setUrl] = useState(block.url ?? "");
  const [error, setError] = useState("");
  if (block.type === "divider") return <hr />;
  if (block.type === "text")
    return (
      <WorkflowRichText
        fullDocument
        label="Text block"
        value={block.text}
        maxLength={8000}
        onChange={(text) => change({ text })}
      />
    );
  if (block.type === "heading")
    return (
      <InlineText
        className={styles.heading}
        label="Heading block"
        value={block.text}
        onChange={(text) => change({ text })}
      />
    );
  return (
    <figure className={styles.media}>
      {block.url ? (
        block.type === "image" ? (
          <img
            src={block.url}
            alt={block.text || "SOP image"}
            loading="lazy"
            draggable={false}
          />
        ) : (
          <video
            src={block.url}
            controls
            preload="metadata"
            aria-label={block.text || "SOP video"}
          />
        )
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!url.trim() || !safeBlockMediaUrl(url.trim())) {
              setError("Enter a valid HTTPS media URL.");
              return;
            }
            change({ url: url.trim() });
            setError("");
          }}
        >
          <input
            aria-label={block.type === "image" ? "Image URL" : "Video URL"}
            placeholder={
              block.type === "image"
                ? "Paste an image URL…"
                : "Paste a video URL…"
            }
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <button type="submit">Add</button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
      <figcaption>
        <InlineText
          label="Media caption"
          placeholder="Add a caption…"
          value={block.text}
          onChange={(text) => change({ text })}
        />
      </figcaption>
    </figure>
  );
}
