/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  experimental: {
    instrumentationHook: true,
  },
  async redirects() {
    return [
      {
        source: "/charts",
        destination: "/antaeus",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
