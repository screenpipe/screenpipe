/** @type {import('next').NextConfig} */
const nextConfig = {
    output: 'export',
    images: {
        unoptimized: true,
    },
    eslint: {
        // Disable eslint during builds - we run it separately in CI
        ignoreDuringBuilds: true,
    },
    // Ship sourcemaps with the prod bundle so React #185 / similar minified
    // stack traces decode to real component + file names in the logs (the
    // bundle is shipped only inside the Tauri app, not over a public CDN,
    // so this isn't an information-disclosure concern).
    productionBrowserSourceMaps: true,
}
export default nextConfig;

