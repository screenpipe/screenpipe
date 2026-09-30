// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Browser-mock UI check. Start bun run dev:web first; no native or AI calls.
import { chromium } from "../../screenpipe-workflows-web/node_modules/playwright/index.mjs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const output = process.env.SCREENPIPE_CHAT_UI_OUTPUT;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  colorScheme: "light",
});
page.on("pageerror", (e) => console.log("pageerror", e.message));
const snap = async (name) => {
  if (!output) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(output, `actions-${name}.png`) });
};
try {
  await page.goto(
    `${process.env.SCREENPIPE_CHAT_UI_URL || "http://127.0.0.1:1420"}/home`,
  );
  await page.getByRole("button", { name: "Do later", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.classList.add("light");
  });
  await page.keyboard.press("Alt+Meta+b");
  await page.getByRole("heading", { name: "Keep your work close" }).waitFor();
  await snap("home-light");
  await page.getByRole("button", { name: /Files and outputs/ }).click();
  await page
    .getByRole("heading", { name: "No files in this chat yet" })
    .waitFor();
  await snap("files-empty");
  await page.getByRole("button", { name: "Chat tools", exact: true }).click();
  await page.getByRole("button", { name: /Browser Open a website/ }).click();
  await page.getByRole("textbox", { name: "Browser address" }).waitFor();
  await page.getByRole("button", { name: "Side panel home" }).click();
  await page.getByRole("heading", { name: "Keep your work close" }).waitFor();
  await snap("home-with-tab");
  await page.keyboard.press("Alt+Meta+b");
  await page
    .getByRole("heading", { name: "Keep your work close" })
    .waitFor({ state: "hidden" });
  await page.keyboard.press("Alt+Meta+b");
  await page.getByRole("heading", { name: "Keep your work close" }).waitFor();
  await page.getByRole("button", { name: "Chat actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /Rename/ }).waitFor();
  await snap("top-menu-light");
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "hidden" });
  await page.waitForTimeout(200);
  await page.keyboard.press("Alt+Meta+r");
  await page.getByRole("textbox", { name: "Rename New chat" }).waitFor();
  await page
    .getByRole("textbox", { name: "Rename New chat" })
    .fill("Planning the week");
  await page.keyboard.press("Enter");
  await page
    .getByRole("tab", { name: "Planning the week", exact: true })
    .waitFor();
  await page.keyboard.press("Alt+Meta+p");
  await page.getByRole("button", { name: "Chat actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /Unpin/ }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "hidden" });
  await page.waitForTimeout(200);
  await page
    .getByRole("tab", { name: "Planning the week", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: /Rename/ }).waitFor();
  await snap("tab-menu-light");
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "hidden" });
  await page.waitForTimeout(200);
  await page
    .getByRole("button", { name: /Investigate audio device switching/ })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: /Branch in new chat/ }).waitFor();
  await snap("sidebar-menu-light");
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "hidden" });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    document.documentElement.classList.remove("light");
    document.documentElement.classList.add("dark");
  });
  await snap("home-dark");
  await page.getByRole("button", { name: "Chat actions", exact: true }).click();
  await snap("top-menu-dark");
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "hidden" });
  await page.waitForTimeout(200);
  await page.setViewportSize({ width: 1100, height: 780 });
  await snap("compact");
  console.log(
    "PASS: panel destinations, retained browser tab, repeat toggle, global rename and pin, menu parity, light/dark/compact",
  );
} finally {
  await browser.close();
}
