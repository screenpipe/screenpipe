// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { ReactElement } from "react";
import { createRequire } from "node:module";
import { render, screen } from "@testing-library/react";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { describe, expect, it } from "vitest";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

const require = createRequire(import.meta.url);
const tailwindConfig = require("../../tailwind.config.ts");

function renderedClassNames(ui: ReactElement, role: "dialog" | "alertdialog") {
  const { unmount } = render(ui);
  const classNames = {
    overlay: document.querySelector("[data-modal-overlay]")!.className,
    content: screen.getByRole(role).className,
  };
  unmount();
  return classNames;
}

/**
 * The animations a class list can run in `state`, compiled with the app's
 * config. Rules without a state condition count too.
 */
async function animationsFor(className: string, state: "open" | "closed") {
  const otherState = state === "open" ? "closed" : "open";
  const { root } = await postcss([
    tailwindcss({ ...tailwindConfig, content: [{ raw: className }] }),
  ]).process("@tailwind utilities;", { from: undefined });

  const keyframes = new Map<string, string[]>();
  root.walkAtRules("keyframes", (rule) => {
    const properties = new Set<string>();
    rule.walkDecls((declaration) => properties.add(declaration.prop));
    keyframes.set(rule.params, [...properties].sort());
  });

  const animations: { duration?: string; properties?: string[] }[] = [];
  root.walkRules((rule) => {
    if (rule.selector.includes(`[data-state="${otherState}"]`)) return;
    let name: string | undefined;
    let duration: string | undefined;
    rule.walkDecls((declaration) => {
      if (declaration.prop === "animation") {
        [name, duration] = declaration.value.split(/\s+/);
      }
      if (declaration.prop === "animation-name") name = declaration.value;
      if (declaration.prop === "animation-duration") duration = declaration.value;
    });
    if (name) animations.push({ duration, properties: keyframes.get(name) });
  });
  return animations;
}

const openDialog = (
  <Dialog open>
    <DialogContent>
      <DialogTitle>Title</DialogTitle>
      <DialogDescription>Description</DialogDescription>
    </DialogContent>
  </Dialog>
);

const openAlertDialog = (
  <AlertDialog open>
    <AlertDialogContent>
      <AlertDialogTitle>Title</AlertDialogTitle>
      <AlertDialogDescription>Description</AlertDialogDescription>
    </AlertDialogContent>
  </AlertDialog>
);

describe("dialog motion", () => {
  it.each([
    ["Dialog", "dialog", openDialog],
    ["AlertDialog", "alertdialog", openAlertDialog],
  ] as const)("%s opens and closes with a 150ms fade that never moves it", async (_, role, ui) => {
    // docs/DESIGN.md: dialogs use a 150ms fade. Animating only opacity is also
    // what keeps them centered; a keyframe that writes `transform` replaces the
    // centering translate and slides the dialog in from off-center.
    const classNames = renderedClassNames(ui, role);
    for (const className of [classNames.overlay, classNames.content]) {
      for (const state of ["open", "closed"] as const) {
        expect(await animationsFor(className, state)).toEqual([
          { duration: "150ms", properties: ["opacity"] },
        ]);
      }
    }
  });
});
