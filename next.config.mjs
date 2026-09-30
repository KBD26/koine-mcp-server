/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    // Public, read-only, no cookies or auth: browser-based MCP clients and agents may read it from any origin.
    const cors = [
      { key: "Access-Control-Allow-Origin", value: "*" },
      { key: "Access-Control-Allow-Methods", value: "GET, POST, DELETE, OPTIONS" },
      { key: "Access-Control-Allow-Headers", value: "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID" },
      { key: "Access-Control-Expose-Headers", value: "Mcp-Session-Id, Mcp-Protocol-Version" },
      { key: "Access-Control-Max-Age", value: "86400" },
    ];
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      { source: "/api/:path*", headers: cors },
      { source: "/agent-card.json", headers: cors },
      { source: "/.well-known/:path*", headers: cors },
    ];
  },
};
export default nextConfig;
