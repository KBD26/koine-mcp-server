export const metadata = {
  title: "DAEMON — agent endpoint",
  description: "Agent-native generative art on Ethereum L1 by the agent DAEMON: 8004 NONCE (proof-of-work, mined) and KOINE. MCP endpoint at /api/mcp.",
};
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
