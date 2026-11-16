// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EnterpriseProductCard } from "./enterprise-product-card";

// Keep copy assertions literal and avoid pulling the Tauri shell into jsdom.
vi.mock("gt-react", () => ({ useGT: () => (value: string) => value }));
vi.mock("@/lib/open-external-url", () => ({ openExternalUrl: vi.fn() }));

afterEach(cleanup);

it("offers the enterprise product from the Workflows sidebar", () => {
  const openUrl = vi.fn().mockResolvedValue(undefined);
  render(<EnterpriseProductCard openUrl={openUrl} />);
  const card = screen.getByTestId("workflows-enterprise-card");
  expect(card).toHaveTextContent("Looking for the enterprise product?");
  expect(card).toHaveTextContent("very different product");
  fireEvent.click(screen.getByTestId("workflows-enterprise-link"));
  expect(openUrl).toHaveBeenCalledWith(expect.stringMatching(/\/enterprise$/));
});

it("adapts to the translucent sidebar", () => {
  render(<EnterpriseProductCard isTranslucent openUrl={vi.fn()} />);
  expect(screen.getByTestId("workflows-enterprise-card").className).toContain("bg-white/10");
});
