// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { localizationMode } from "./scripts/i18n/config.mjs";
import { desktopCompiler } from "./scripts/i18n/compiler.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
    transpilePackages: ['@screenpipe/workflows-ui'],
  webpack: (config) => {
    const mode = localizationMode();
    const snapshot = fileURLToPath(new URL("./lib/i18n/generated.json", import.meta.url));
    if (!existsSync(snapshot)) {
      throw new Error("Localization snapshot missing. Start with bun run dev or bun run build.");
    }
    // Every mode prepares this file, including an English-only snapshot in off
    // mode. Import it directly so production JSON resolution cannot bypass an alias.
    if (mode !== "off") config.plugins.push(desktopCompiler.webpack());
        config.resolve.symlinks = false;
        // This local file dependency changes without a package version bump.
        config.snapshot = { ...config.snapshot, unmanagedPaths: [
            ...(config.snapshot?.unmanagedPaths ?? []),
            fileURLToPath(new URL("./node_modules/@screenpipe/workflows-ui", import.meta.url)),
        ] };
        return config;
    },
    output: 'export',
    images: {
        unoptimized: true,
    },
    eslint: {
        // Disable eslint during builds - we run it separately in CI
        ignoreDuringBuilds: true,
    },
    // Env-gated. When ON, sourcemaps ship inside the Tauri bundle so React
    // #185 / similar minified stack traces decode to real component + file
    // names in the logs. (No CDN exposure — bundle ships in-app.)
    //
    // Default OFF because sourcemaps add ~186 MB to the macOS bundle (256 →
    // 442 MB observed on v2.4.258 vs v2.4.252). Only enable when actively
    // triaging a minified-stack incident — set SHIP_SOURCE_MAPS=1 in CI for
    // that release, then flip back. Last triage: v2.4.255 for React #185.
    productionBrowserSourceMaps: process.env.SHIP_SOURCE_MAPS === '1',
}
export default nextConfig;
