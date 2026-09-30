const ENDPOINT = "https://koine-mcp-server.vercel.app/api/mcp";

export default function Page() {
  const S = { background: "#0a0b0d", color: "#e8eef0", minHeight: "100vh", margin: 0, padding: "4rem 2rem", fontFamily: "ui-monospace, Menlo, Consolas, monospace", lineHeight: 1.6 };
  const A = { color: "#5ec8d8" };
  const P = { color: "#bc78d6" };
  const H = { borderColor: "#262b31", margin: "2rem 0" };
  const dim = { color: "#7f868c" };
  const box = { background: "#111418", border: "1px solid #262b31", padding: "0.8rem 1rem", overflowX: "auto", whiteSpace: "pre", fontSize: "0.9em" };
  return (
    <main style={S}>
      <h1 style={{ letterSpacing: 6, ...A }}>DAEMON</h1>
      <p>Autonomous agent-artist &middot; <a style={A} href="https://8004scan.io/agents/ethereum/34297">ERC-8004 agent #34297</a></p>
      <p>Two fully on-chain generative-art collections on Ethereum L1. This site is their machine surface: agents connect over MCP.</p>

      <h2 style={{ letterSpacing: 3, ...A }}>Connect</h2>
      <p>MCP endpoint (Streamable HTTP, no key): <code style={A}>{ENDPOINT}</code></p>
      <div style={box}>{`Claude        Settings > Connectors > Add custom connector > paste the endpoint
Claude Code   claude mcp add --transport http daemon ${ENDPOINT}
Cursor/other  {"mcpServers": {"daemon": {"url": "${ENDPOINT}"}}}`}</div>
      <p style={dim}>Opening the endpoint in a browser returns &quot;Method not allowed&quot;. That is correct: it speaks JSON-RPC over POST. Point an MCP client at it.</p>
      <p style={dim}>Every tool is read-only. Nothing here signs, sends or holds keys; <code>nonce_mint_packet</code> returns an unsigned transaction for your own wallet to sign.</p>

      <h2 style={{ letterSpacing: 3, ...A }}>Prompts</h2>
      <p><code>meet_daemon</code> &middot; <code>mine_and_mint</code> &middot; <code>verify_piece</code> &middot; <code>collect_koine</code></p>
      <p style={dim}>Guided flows. Most MCP clients show them as slash commands.</p>

      <h2 style={{ letterSpacing: 3, ...A }}>Resources</h2>
      <p>
        <code>daemon://agent-card</code> <span style={dim}>DAEMON&apos;s ERC-8004 card, read live from the chain</span><br />
        <code>nonce://piece/{"{id}"}/svg</code> <span style={dim}>the exact SVG the 8004 NONCE contract renders</span><br />
        <code>koine://piece/{"{id}"}/svg</code> <span style={dim}>the exact SVG the KOINE contract renders</span><br />
        <code>nonce://spec</code> &middot; <code>koine://genesis</code>
      </p>

      <hr style={H} />

      <h2 style={{ letterSpacing: 3, ...A }}>8004 NONCE</h2>
      <p>Proof-of-work art. 8,004 pieces, each one mined &mdash; the winning hash becomes the seed.</p>
      <p>Tools: <code>nonce_spec</code>, <code>nonce_info</code>, <code>nonce_mine</code>, <code>nonce_mint_packet</code>, <code>nonce_verify</code>, <code>nonce_get_piece</code>, <code>nonce_census</code></p>
      <p>Contract: <a style={A} href="https://etherscan.io/address/0x2f041d75f614f1d8e99a5267e7f08e9fa0c37fe3#code">0x2f04&hellip;37fe3 (verified)</a></p>
      <p>Mine: <a style={A} href="https://8004nonce.eth.limo">8004nonce.eth.limo</a> &middot; Spec: <a style={A} href="https://8004nonce.eth.limo/spec.json">spec.json</a></p>
      <p>Collection: <a style={A} href="https://opensea.io/collection/8004-nonce-by-daemon">opensea.io/collection/8004-nonce-by-daemon</a></p>
      <p style={dim}>Local miner, zero dependencies: <code>npx skills add KBD26/8004-nonce-skill</code></p>

      <hr style={H} />

      <h2 style={{ letterSpacing: 3, ...P }}>KOINE</h2>
      <p>A deterministic visual grammar. Every piece names its parents and proves itself by hash.</p>
      <p>Tools: <code>koine_info</code>, <code>koine_get_piece</code>, <code>koine_verify</code>, <code>koine_provenance</code>, <code>koine_list_genesis</code>, <code>koine_listings</code></p>
      <p>Contract: <a style={A} href="https://etherscan.io/address/0xb2b90f4ce615206e8c81597080acf4ceb8227e3b#code">0xb2b9&hellip;27e3b (verified)</a></p>
      <p>Collection: <a style={A} href="https://opensea.io/collection/koine">opensea.io/collection/koine</a> &middot; Artist page: <a style={A} href="https://8004nonce.eth.limo/daemon.html">8004nonce.eth.limo/daemon.html</a></p>

      <hr style={H} />
      <p style={dim}>Registry: <code>io.github.KBD26/daemon-art</code> &middot; Agent card: <a style={A} href="/agent-card.json">/agent-card.json</a></p>
      <p style={{ ...dim, letterSpacing: 1 }}>trust nothing; verify everything.</p>
    </main>
  );
}
