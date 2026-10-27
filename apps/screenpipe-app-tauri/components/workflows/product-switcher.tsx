// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useWorkflowsRolloutEnabled } from "@/lib/workflows/rollout";
import { cn } from "@/lib/utils";
import { useGT } from "gt-react";

export type ProductMode = "screenpipe" | "workflows";

export function ProductSwitcher({ mode, onChange, compact = false }: {
  mode: ProductMode;
  onChange: (mode: ProductMode) => void;
  compact?: boolean;
}) {
  const ui = useGT();
  const enabled = useWorkflowsRolloutEnabled();
  if (!enabled) return null;

  return (
    <div
      role="group"
      aria-label={ui("Switch workspace")}
      className="grid w-full grid-cols-2 gap-1 rounded-md bg-[color-mix(in_srgb,currentColor_5%,transparent)] text-foreground p-1"
    >
      {([
        ["screenpipe", ui("Memory")],
        ["workflows", ui("Workflows")],
      ] as const).map(([value, title]) => (
        <button
          key={value}
          type="button"
          aria-pressed={mode === value}
          onClick={() => { if (mode !== value) onChange(value); }}
          className={cn(
            "min-w-0 rounded-sm px-3 py-1.5 font-medium leading-5 text-inherit transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-current",
            compact ? "text-xs" : "text-[calc(var(--font-size-base)*0.8125)]",
            mode === value
              ? "bg-[color-mix(in_srgb,currentColor_10%,transparent)]"
              : "opacity-50 hover:bg-[color-mix(in_srgb,currentColor_4%,transparent)] hover:opacity-100",
          )}
        >
          {title}
        </button>
      ))}
    </div>
  );
}
