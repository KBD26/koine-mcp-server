import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { ethers } from "ethers";

export const runtime = "nodejs";        // ethers needs the Node runtime, not edge
export const dynamic = "force-dynamic"; // always live, never cached
export const maxDuration = 30;

const RPC = process.env.KOINE_RPC || "https://cloudflare-eth.com";
const ADDR = process.env.KOINE_ADDR || "0xb2b90f4ce615206e8c81597080acf4ceb8227e3b";
const OPENSEA = "https://opensea.io/collection/koine";
const OPENSEA_API = "https://api.opensea.io/api/v2";
const OS_KEY = process.env.OPENSEA_API_KEY || "";          // optional — enables live listing prices
const COLLECTION_SLUG = process.env.KOINE_SLUG || "koine";

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

    server.tool(
      "koine_listings",
      "KOINE pieces currently for sale, cheapest first, so an agent can COLLECT. Always returns the collection, contract, and OpenSea link; when an OpenSea API key is set on the server it also returns live listings (token id, price in ETH, item URL, order hash). Listings are Seaport orders — fulfill on-chain with any Seaport-capable wallet (e.g. the opensea-js SDK) from a funded address.",
      {},
      async () => {
        const base = {
          collection: "KOINE",
          contract: ADDR,
          chain: "ethereum-mainnet",
          opensea: OPENSEA,
          how_to_buy: "Listings are Seaport orders on OpenSea. Fetch with the OpenSea API or opensea-js and fulfill on-chain from a funded wallet.",
        };
        if (!OS_KEY) return txt({ ...base, live_listings: false, note: "Set OPENSEA_API_KEY on the server for live prices." });
        try {
          const r = await fetch(`${OPENSEA_API}/listings/collection/${COLLECTION_SLUG}/best?limit=50`, {
            headers: { "X-API-KEY": OS_KEY, accept: "application/json" },
          });
          if (!r.ok) return txt({ ...base, live_listings: false, error: `OpenSea API ${r.status}` });
          const data = await r.json();
          const listings = (data.listings || []).map((l) => {
            const pc = l.price && l.price.current;
            const eth = pc ? Number(pc.value) / 10 ** Number(pc.decimals) : null;
            const off = l.protocol_data && l.protocol_data.parameters && l.protocol_data.parameters.offer;
            const tid = off && off[0] && off[0].identifierOrCriteria;
            return {
              token_id: tid != null ? Number(tid) : null,
              price_eth: eth,
              currency: (pc && pc.currency) || "ETH",
              item: tid != null ? `https://opensea.io/assets/ethereum/${ADDR}/${tid}` : OPENSEA,
              order_hash: l.order_hash || null,
            };
          }).filter((x) => x.price_eth != null).sort((a, b) => a.price_eth - b.price_eth);
          return txt({ ...base, live_listings: true, count: listings.length, floor_eth: listings.length ? listings[0].price_eth : null, listings });
        } catch (e) {
          return txt({ ...base, live_listings: false, error: String(e) });
        }
      }
    );
  },
  {},
  { basePath: "/api" }
);

export { handler as GET, handler as POST };
