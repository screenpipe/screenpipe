// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React, { type ReactElement } from "react";
import { render as renderWithoutProviders } from "@testing-library/react";
import { GTProvider, initializeGT } from "gt-react";

// Match the app's offline English default when testing an isolated component.
initializeGT({ defaultLocale: "en", locales: [], loadTranslations: async () => ({}), runtimeUrl: null, _disableDevHotReload: true });

export function render(ui: ReactElement) {
  return renderWithoutProviders(ui, {
    wrapper: ({ children }) => <GTProvider locale="en" translations={{}}>{children}</GTProvider>,
  });
}
