// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagAccountSync } from "./feature-flag-account-sync";

const f = vi.hoisted(() => ({
  loaded: false,
  email: null as string | null,
  setProperties: vi.fn(),
  identify: vi.fn(),
  optIn: vi.fn(),
}));
vi.mock("@/lib/hooks/use-settings", () => ({ useSettings: () => ({
  isSettingsLoaded: f.loaded,
  settings: { analyticsEnabled: false, user: { email: f.email } },
}) }));
vi.mock("posthog-js", () => ({ default: {
  setPersonPropertiesForFlags: f.setProperties,
  identify: f.identify,
  opt_in_capturing: f.optIn,
} }));

beforeEach(() => { vi.clearAllMocks(); f.loaded = false; f.email = null; });
describe("account feature flag evaluation", () => {
  it("waits for both settings and the SDK", () => {
    const view = render(<FeatureFlagAccountSync ready={false} />);
    f.loaded = true; f.email = "beta@example.com";
    view.rerender(<FeatureFlagAccountSync ready={false} />);
    expect(f.setProperties).not.toHaveBeenCalled();
    view.rerender(<FeatureFlagAccountSync ready />);
    expect(f.setProperties).toHaveBeenCalledWith({ email: "beta@example.com" });
  });
  it("evaluates an opted-out account without enabling analytics", () => {
    f.loaded = true; f.email = "beta@example.com";
    render(<FeatureFlagAccountSync ready />);
    expect(f.setProperties).toHaveBeenCalledOnce();
    expect(f.identify).not.toHaveBeenCalled();
    expect(f.optIn).not.toHaveBeenCalled();
  });
  it("updates on account changes and clears the email on logout", () => {
    f.loaded = true; f.email = "first@example.com";
    const view = render(<FeatureFlagAccountSync ready />);
    view.rerender(<FeatureFlagAccountSync ready />);
    expect(f.setProperties).toHaveBeenCalledTimes(1);
    f.email = "second@example.com";
    view.rerender(<FeatureFlagAccountSync ready />);
    expect(f.setProperties).toHaveBeenLastCalledWith({ email: "second@example.com" });
    f.email = null;
    view.rerender(<FeatureFlagAccountSync ready />);
    expect(f.setProperties).toHaveBeenLastCalledWith({ email: null });
  });
  it("does not evaluate unloaded account defaults", () => {
    render(<FeatureFlagAccountSync ready />);
    expect(f.setProperties).not.toHaveBeenCalled();
  });
});
