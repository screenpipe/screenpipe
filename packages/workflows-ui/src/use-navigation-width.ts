// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useRef, useState, type PointerEvent } from "react";

const KEY = "workflows:navigation-width";
const DEFAULT = 240;
const MIN = 192;
const MAX = 448;

/** Match the chat sidebar's width range and persist only completed gestures. */
export function useNavigationWidth(enabled: boolean, docked: boolean) {
  const [preferred, setPreferred] = useState(DEFAULT);
  const [viewport, setViewport] = useState(1440);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ x: number; width: number; previous: number } | null>(
    null,
  );
  const maximum = Math.max(
    MIN,
    Math.min(
      MAX,
      viewport - (viewport <= 680 ? 48 : docked && viewport >= 960 ? 700 : 360),
    ),
  );
  const clamp = (value: number) =>
    Math.round(Math.max(MIN, Math.min(maximum, value)));
  const width = clamp(preferred);
  useEffect(() => {
    try {
      const stored = Number(window.localStorage.getItem(KEY));
      if (Number.isFinite(stored) && stored >= MIN)
        setPreferred(Math.min(MAX, stored));
    } catch {
      /* Resizing also works without storage access. */
    }
    const resize = () => setViewport(window.innerWidth);
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    if (!enabled) {
      if (drag.current) setPreferred(drag.current.previous);
      drag.current = null;
      setResizing(false);
    }
  }, [enabled]);
  useEffect(() => {
    if (!resizing) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [resizing]);
  function persist(value: number) {
    setPreferred(value);
    try {
      window.localStorage.setItem(KEY, String(value));
    } catch {
      /* Session width still applies. */
    }
  }
  function cancel() {
    if (!drag.current) return;
    setPreferred(drag.current.previous);
    drag.current = null;
    setResizing(false);
  }
  return {
    width,
    resizing,
    separatorProps: {
      role: "separator",
      tabIndex: 0,
      "aria-orientation": "vertical" as const,
      "aria-label": "Resize left sidebar",
      "aria-controls": "workflows-navigation",
      "aria-valuemin": MIN,
      "aria-valuemax": maximum,
      "aria-valuenow": width,
      title: "Drag to resize. Double-click to reset. Arrow keys adjust width.",
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        drag.current = { x: event.clientX, width, previous: preferred };
        setResizing(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;
        setPreferred(clamp(drag.current.width + event.clientX - drag.current.x));
      },
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;
        persist(clamp(drag.current.width + event.clientX - drag.current.x));
        drag.current = null;
        setResizing(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      },
      onPointerCancel: cancel,
      onLostPointerCapture: cancel,
      onDoubleClick: () => persist(clamp(DEFAULT)),
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") {
          cancel();
          return;
        }
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        event.stopPropagation();
        persist(
          event.key === "Home"
            ? MIN
            : event.key === "End"
              ? maximum
              : clamp(
                  width +
                    (event.key === "ArrowRight" ? 1 : -1) *
                      (event.shiftKey ? 32 : 8),
                ),
        );
      },
    },
  };
}
