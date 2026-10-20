/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
