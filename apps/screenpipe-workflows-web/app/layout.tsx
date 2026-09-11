// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Screenpipe Workflows",
  description: "See how your work actually flows, where time goes, and what gets stuck.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
