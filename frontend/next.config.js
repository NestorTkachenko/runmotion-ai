/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow feetech.js (browser-only) to be bundled without crashing during SSR
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Mark feetech.js as external on server (it uses Web Serial API)
      config.externals = [...(config.externals || []), 'feetech.js'];
    }
    return config;
  },
  // Required for Vercel deployment with dynamic socket.io routes
  async rewrites() {
    return [
      {
        source: '/socket.io/:path*',
        destination: `${process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'}/socket.io/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
