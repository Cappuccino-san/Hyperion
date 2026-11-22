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
        destination: "/gaia",
        permanent: true,
      },
      {
        source: "/antaeus",
        destination: "/gaia",
        permanent: true,
      },
      {
        source: "/atlas",
        destination: "/gaia",
        permanent: true,
      },
    ];
  },
};

export default function configureNext(phase) {
  return {
    ...nextConfig,
    distDir: phase === "phase-development-server" ? ".next-dev" : ".next",
  };
}
