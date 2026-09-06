// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  transpilePackages: ["@screenpipe/workflows-ui"],
  webpack: (config) => {
    config.resolve.symlinks = false;
    return config;
  },
};

export default nextConfig;
