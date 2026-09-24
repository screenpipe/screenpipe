// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useLayoutEffect, useRef } from "react";
import { WorkflowRichText } from "./rich-text";

export function InlineText({
  label,
  value,
  onChange,
  placeholder = label,
  rich = false,
  className,
  maxLength = 8000,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  placeholder?: string;
  rich?: boolean;
  className?: string;
  maxLength?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    const resize = () => {
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
    };
    resize();
    let width = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (field.clientWidth !== width) {
        width = field.clientWidth;
        resize();
      }
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [value]);
  if (rich)
    return (
      <WorkflowRichText
        label={label}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        maxLength={maxLength}
      />
    );
  return (
    <textarea
      ref={ref}
      rows={1}
      aria-label={label}
      placeholder={placeholder}
      className={className}
      value={value}
      maxLength={maxLength}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
