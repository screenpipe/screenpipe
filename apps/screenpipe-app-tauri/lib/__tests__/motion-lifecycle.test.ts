// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { createRequire } from "node:module";
import { createElement as reactElement } from "react";
import { render } from "@testing-library/react";
import * as motionEsm from "framer-motion";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const motionCjs = require("framer-motion") as typeof motionEsm;

function withInheritedEntry(run: () => void) {
  const key = "screenpipeInheritedMotionEntry";
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
  Object.defineProperty(Object.prototype, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: {},
  });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(Object.prototype, key, previous);
    else Reflect.deleteProperty(Object.prototype, key);
  }
}

// Exercise both package entry points: Next bundles ESM while Node can use CJS.
describe.each([["ESM", motionEsm], ["CJS", motionCjs]] as const)("%s motion lifecycle", (_, motion) => {
  function createElement() {
    // The base class implements the lifecycle; renderer-specific abstract
    // methods are not involved in feature registration or event cleanup.
    return Reflect.construct(motion.VisualElement, [{
      props: {},
      visualState: { latestValues: {}, renderState: {} },
    }]) as motionEsm.VisualElement;
  }

  it("does not mount inherited properties as animation features", () => {
    const element = createElement();
    withInheritedEntry(() => {
      expect(() => element.updateFeatures()).not.toThrow();
    });
    element.unmount();
  });

  it("cleans up real listeners without treating inherited properties as listeners", () => {
    const element = createElement();
    const onUpdate = vi.fn();
    element.on("Update", onUpdate);
    element.notify("Update", { opacity: 1 });
    expect(onUpdate).toHaveBeenCalledOnce();

    withInheritedEntry(() => {
      expect(() => element.unmount()).not.toThrow();
    });
    element.notify("Update", { opacity: 0 });
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("destroys motion values and releases their real listeners", () => {
    const value = motion.motionValue(0);
    const onChange = vi.fn();
    value.on("change", onChange);
    value.set(1);
    expect(onChange).toHaveBeenCalledOnce();

    withInheritedEntry(() => {
      expect(() => value.destroy()).not.toThrow();
    });
    value.set(2);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("updates and unmounts a real animated React element with inherited entries present", () => {
    const view = (opacity: number) => reactElement(motion.motion.div, {
      initial: false,
      animate: { opacity },
      transition: { duration: 0 },
      whileHover: { opacity: 0.5 },
      children: "Animated content",
    });
    const { rerender, unmount, getByText } = render(view(1));
    expect(getByText("Animated content")).toBeInTheDocument();
    withInheritedEntry(() => {
      rerender(view(0.8));
      unmount();
    });
  });
});
