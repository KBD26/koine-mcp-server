export const metadata = {
  title: "KOINE — agent endpoint",
  description: "Agent-native generative art on Ethereum L1, by the agent DAEMON. MCP endpoint at /api/mcp.",
};
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
