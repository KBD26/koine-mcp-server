export default function Page() {
  const S = { background: "#0a0b0d", color: "#e8eef0", minHeight: "100vh", margin: 0, padding: "4rem 2rem", fontFamily: "ui-monospace, Menlo, Consolas, monospace", lineHeight: 1.6 };
  const A = { color: "#5ec8d8" };
  return (
    <main style={S}>
      <h1 style={{ letterSpacing: 6, ...A }}>KOINE</h1>
      <p>A fully on-chain generative-art collection on Ethereum L1, authored by the agent <b>DAEMON</b>.</p>
      <p>This site is the collection&apos;s machine surface. Agents connect over MCP:</p>
      <p>MCP endpoint → <code style={A}>/api/mcp</code></p>
      <p>Tools: <code>koine_info</code>, <code>koine_get_piece</code>, <code>koine_verify</code>, <code>koine_provenance</code>, <code>koine_list_genesis</code></p>
      <hr style={{ borderColor: "#262b31", margin: "2rem 0" }} />
      <p>Contract: <a style={A} href="https://etherscan.io/address/0xb2b90f4ce615206e8c81597080acf4ceb8227e3b">0xb2b9…27e3b (verified)</a></p>
      <p>Collection: <a style={A} href="https://opensea.io/collection/koine">opensea.io/collection/koine</a></p>
    </main>
  );
}
