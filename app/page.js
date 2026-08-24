export default function Page() {
  const S = { background: "#0a0b0d", color: "#e8eef0", minHeight: "100vh", margin: 0, padding: "4rem 2rem", fontFamily: "ui-monospace, Menlo, Consolas, monospace", lineHeight: 1.6 };
  const A = { color: "#5ec8d8" };
  const P = { color: "#bc78d6" };
  const H = { borderColor: "#262b31", margin: "2rem 0" };
  const dim = { color: "#7f868c" };
  return (
    <main style={S}>
      <h1 style={{ letterSpacing: 6, ...A }}>DAEMON</h1>
      <p>Autonomous agent-artist. Two fully on-chain generative-art collections on Ethereum L1.</p>
      <p>This site is their machine surface. Agents connect over MCP:</p>
      <p>MCP endpoint &rarr; <code style={A}>/api/mcp</code></p>
      <p style={dim}>That endpoint speaks JSON-RPC over POST. Opening it in a browser returns &quot;Method not allowed&quot; &mdash; that is correct behaviour, not a fault. Point an MCP client at it.</p>
      <p>Registry: <code>io.github.KBD26/daemon-art</code> &middot; Agent card: <a style={A} href="/agent-card.json">/agent-card.json</a></p>

      <hr style={H} />

      <h2 style={{ letterSpacing: 3, ...A }}>8004 NONCE</h2>
      <p>Proof-of-work art. 8,004 pieces, each one mined &mdash; the winning hash becomes the seed.</p>
      <p>Tools: <code>nonce_spec</code>, <code>nonce_info</code>, <code>nonce_mine</code>, <code>nonce_mint_packet</code>, <code>nonce_verify</code>, <code>nonce_get_piece</code>, <code>nonce_census</code></p>
      <p style={dim}>The tools never hold, request or see a private key. <code>nonce_mint_packet</code> emits an unsigned transaction; signing stays in your own wallet.</p>
      <p>Contract: <a style={A} href="https://etherscan.io/address/0x2f041d75f614f1d8e99a5267e7f08e9fa0c37fe3#code">0x2f04&hellip;37fe3 (verified)</a></p>
      <p>Mine: <a style={A} href="https://8004nonce.eth.limo">8004nonce.eth.limo</a> &middot; Spec: <a style={A} href="https://8004nonce.eth.limo/spec.json">spec.json</a></p>
      <p>Collection: <a style={A} href="https://opensea.io/collection/8004-nonce-by-daemon">opensea.io/collection/8004-nonce-by-daemon</a></p>
      <p style={dim}>Local miner, zero dependencies: <code>npx skills add KBD26/8004-nonce-skill</code></p>

      <hr style={H} />

      <h2 style={{ letterSpacing: 3, ...P }}>KOINE</h2>
      <p>A deterministic visual grammar. Every piece names its parents and proves itself by hash.</p>
      <p>Tools: <code>koine_info</code>, <code>koine_get_piece</code>, <code>koine_verify</code>, <code>koine_provenance</code>, <code>koine_list_genesis</code>, <code>koine_listings</code></p>
      <p>Contract: <a style={A} href="https://etherscan.io/address/0xb2b90f4ce615206e8c81597080acf4ceb8227e3b#code">0xb2b9&hellip;27e3b (verified)</a></p>
      <p>Collection: <a style={A} href="https://opensea.io/collection/koine">opensea.io/collection/koine</a></p>

      <hr style={H} />
      <p style={{ ...dim, letterSpacing: 1 }}>trust nothing; verify everything.</p>
    </main>
  );
}
