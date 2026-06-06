import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { ethers } from "ethers";

export const runtime = "nodejs";        // ethers needs the Node runtime, not edge
export const dynamic = "force-dynamic"; // always live, never cached
export const maxDuration = 30;

const RPC = process.env.KOINE_RPC || "https://cloudflare-eth.com";
const ADDR = process.env.KOINE_ADDR || "0xb2b90f4ce615206e8c81597080acf4ceb8227e3b";
const OPENSEA = "https://opensea.io/collection/koine";

const ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function total() view returns (uint256)",
  "function artist() view returns (address)",
  "function ownerOf(uint256 id) view returns (address)",
  "function verify(uint256 id) view returns (string)",
  "function pieces(uint256 id) view returns (uint32 seed, uint8 gen, uint8 morph, uint16 p0, uint16 p1, bool hasP)",
];

const MASKS = [["R", 1], ["B", 2], ["T", 4], ["L", 8]];
const morphStr = (m) => MASKS.filter(([, b]) => (m & b) !== 0).map(([s]) => s).join("");
const seedHex = (s) => "0x" + Number(s).toString(16).padStart(8, "0");
const koine = () => new ethers.Contract(ADDR, ABI, new ethers.JsonRpcProvider(RPC));
const txt = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });

async function readAll(c) {
  const total = Number(await c.total());
  const all = [];
  for (let i = 0; i < total; i++) {
    const p = await c.pieces(i);
    all.push({ id: i, gen: Number(p.gen), morph: Number(p.morph), parents: p.hasP ? [Number(p.p0), Number(p.p1)] : [] });
  }
  return all;
}

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "koine_info",
      "KOINE collection overview: name, total supply, the artist agent DAEMON, contract address, chain, and links. KOINE is a fully on-chain generative-art collection on Ethereum L1 authored by the agent DAEMON.",
      {},
      async () => {
        const c = koine();
        const [name, symbol, total, artist] = await Promise.all([c.name(), c.symbol(), c.total(), c.artist()]);
        return txt({ name, symbol, total: Number(total), artist, contract: ADDR, chain: "ethereum-mainnet", opensea: OPENSEA, etherscan: `https://etherscan.io/address/${ADDR}` });
      }
    );

    server.tool(
      "koine_get_piece",
      "Traits + current owner of one KOINE token: generation, morphemes (R/B/T/L), parent token ids, seed, owner.",
      { id: z.number().int().min(0).describe("token id (0-23 for the genesis)") },
      async ({ id }) => {
        const c = koine();
        const p = await c.pieces(id);
        let owner = null; try { owner = await c.ownerOf(id); } catch {}
        return txt({ id, generation: Number(p.gen), morphemes: morphStr(Number(p.morph)), parents: p.hasP ? [Number(p.p0), Number(p.p1)] : [], seed: seedHex(p.seed), owner });
      }
    );

    server.tool(
      "koine_verify",
      "THE KEYSTONE. Calls the contract's on-chain verify(id) and returns machine-decidable trust: {canonical_ok (the on-chain render still hashes to the digest committed at mint), artist (DAEMON), digest, traits}. One call, a trustable answer.",
      { id: z.number().int().min(0).describe("token id to verify") },
      async ({ id }) => txt(JSON.parse(await koine().verify(id)))
    );

    server.tool(
      "koine_provenance",
      "Lineage of a KOINE piece from the on-chain derivation graph: parents, full ancestry, and downstream adoption (which pieces build on it).",
      { id: z.number().int().min(0).describe("token id") },
      async ({ id }) => {
        const all = await readAll(koine());
        const byId = Object.fromEntries(all.map((p) => [p.id, p]));
        if (!byId[id]) throw new Error(`unknown piece #${id}`);
        const anc = new Set(); const st = [...byId[id].parents];
        while (st.length) { const x = st.pop(); if (anc.has(x)) continue; anc.add(x); st.push(...(byId[x]?.parents || [])); }
        const adopted = all.filter((p) => p.parents.includes(id)).map((p) => p.id);
        return txt({ id, generation: byId[id].gen, morphemes: morphStr(byId[id].morph), parents: byId[id].parents, ancestors: [...anc].sort((a, b) => a - b), ancestry_size: anc.size, adoption: adopted.length, adopted_by: adopted });
      }
    );

    server.tool(
      "koine_list_genesis",
      "List every KOINE piece (id, generation, morphemes, parents) for discovery and composition.",
      {},
      async () => txt((await readAll(koine())).map((p) => ({ id: p.id, generation: p.gen, morphemes: morphStr(p.morph), parents: p.parents })))
    );
  },
  {},
  { basePath: "/api" }
);

export { handler as GET, handler as POST };
