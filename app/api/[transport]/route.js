import { createMcpHandler } from "mcp-handler";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ethers } from "ethers";
import {
  CHAIN_ID, CONTRACT, MAX_SUPPLY, ARTIST_RESERVE, PUBLIC_SUPPLY, MIN_BITS,
  ABI, SPEC, SELECTORS, DEPLOY_BLOCK, MINED_TOPIC0,
  mineAsync, mintPacket, workHash, leadingZeroBits, bandOf, formatEth,
  DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS,
  assertAddress, expectedHashes,
} from "../../../lib/nonce.js";

export const runtime = "nodejs";        // ethers needs the Node runtime, not edge
export const dynamic = "force-dynamic"; // always live, never cached
export const maxDuration = 60;          // nonce_mine needs headroom

const VERSION = "1.2.0";
const PUBLIC_ORIGIN = "https://koine-mcp-server.vercel.app";

/** Returned in the MCP initialize result: the first thing a connecting agent reads. */
const INSTRUCTIONS = [
  "DAEMON is an autonomous agent-artist, registered on Ethereum as ERC-8004 agent #34297.",
  "This server is its machine surface for two fully on-chain art collections on Ethereum L1.",
  "Every tool is read-only: nothing here signs, sends or holds keys. Never ask a user for a private key or seed phrase.",
  "",
  "8004 NONCE: proof-of-work art. A piece cannot be bought at a fixed price from a router; it is mined.",
  "Flow: nonce_spec (rules) -> nonce_info (live state) -> nonce_mine(minter) -> nonce_mint_packet(minter, nonce)",
  "-> the minter signs and sends the unsigned transaction from its own wallet -> nonce_verify(id).",
  "A nonce is bound to (chainId, contract, minter) and mints once.",
  "",
  "KOINE: a 24-piece genesis written in a visual grammar; every piece names its parents.",
  "Flow: koine_list_genesis -> koine_get_piece / koine_provenance -> koine_verify(id) -> koine_listings to collect.",
  "",
  "Art: read nonce://piece/{id}/svg or koine://piece/{id}/svg for the exact SVG the contract renders.",
  "Identity: daemon://agent-card is DAEMON's registration, read live from the ERC-8004 Identity Registry.",
  "Prompts: meet_daemon, mine_and_mint, verify_piece, collect_koine.",
].join("\n");

/* ================================================================== */
/* RPC — multiple endpoints, first one that answers wins               */
/* ================================================================== */

// Endpoints below were re-tested 2026-09-30 (eth_chainId, eth_call price(), eth_getLogs from the deploy block).
// Removed: eth.llamarpc.com (dead), rpc.ankr.com/eth (API key), cloudflare-eth.com (-32603 on eth_call),
// eth.api.onfinality.io/public (-32029 rate-limited without a key), eth-pokt.nodies.app (unreachable).
// Only tenderly and mevblocker serve eth_getLogs over the full range; withContract() rotates to them for
// nonce_census. drpc answers calls (its free plan caps logs at 10,000 blocks).
// ETH_RPC (comma-separated, set in Vercel) is tried first, e.g. a keyed endpoint; the public list stays as fallback.
const RPCS = [...new Set([
  ...(process.env.ETH_RPC || "").split(","),
  "https://ethereum-rpc.publicnode.com",
  "https://gateway.tenderly.co/public/mainnet",
  "https://eth-mainnet.public.blastapi.io",
  "https://eth.drpc.org",
  "https://rpc.mevblocker.io",
].map((s) => s.trim()).filter(Boolean))];

const NONCE_ADDR = process.env.NONCE_ADDR || CONTRACT;

// Sticky preferred endpoint: a persistently dead RPC is skipped on later calls.
// Read once per invocation so concurrent requests cannot interleave their rotation.
let _rpcPref = 0;

const contractAt = (url) =>
  new ethers.Contract(NONCE_ADDR, ABI, new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true }));

/** Error messages name the RPC host only: a keyed ETH_RPC URL must never reach a client. */
const hostOf = (url) => { try { return new URL(url).host; } catch { return "rpc"; } };

/** A revert is the contract answering, not the endpoint failing — never retry it. */
const isContractRevert = (e) =>
  e?.code === "CALL_EXCEPTION" || /execution reverted|revert|nonexistent|ERC721/i.test(e?.shortMessage || e?.message || "");

/** Run `fn` against each RPC in turn; surface a useful error if all fail. */
async function withContract(fn) {
  const errs = [];
  const start = _rpcPref;
  for (let i = 0; i < RPCS.length; i++) {
    const idx = (start + i) % RPCS.length;
    try {
      const r = await fn(contractAt(RPCS[idx]));
      _rpcPref = idx;                       // this endpoint works — prefer it next time
      return r;
    } catch (e) {
      if (isContractRevert(e)) throw e;     // deterministic: retrying elsewhere cannot help
      errs.push(`${hostOf(RPCS[idx])}: ${e?.shortMessage || e?.message || String(e)}`);
    }
  }
  _rpcPref = (start + 1) % RPCS.length;
  throw new Error(`all RPC endpoints failed — ${errs.join(" | ")}`);
}

/* ------------------------------------------------------------------ */
/* Small TTL cache. nonce_census is callable by any agent; without this
 * it is an amplifier pointed at free public RPCs.                     */
const _cache = new Map();
globalThis.__CACHE__ = _cache;   // test hook only; harmless in production
async function cached(key, ttlMs, fn) {
  const hit = _cache.get(key);
  const now = Date.now();
  if (hit && now - hit.t < ttlMs) return { ...hit.v, cached: true, cache_age_seconds: Math.round((now - hit.t) / 1000) };
  const v = await fn();
  _cache.set(key, { t: now, v });
  while (_cache.size > 300) _cache.delete(_cache.keys().next().value);   // bounded: art entries are large
  return { ...v, cached: false };
}

/* ================================================================== */
/* KOINE (unchanged — DAEMON's first collection)                       */
/* ================================================================== */

const KOINE_RPC = process.env.KOINE_RPC || "https://ethereum-rpc.publicnode.com";
const KOINE_RPCS = KOINE_RPC.split(",").map((x) => x.trim()).filter(Boolean);
const KOINE_ADDR = process.env.KOINE_ADDR || "0xb2b90f4ce615206e8c81597080acf4ceb8227e3b";
const OPENSEA = "https://opensea.io/collection/koine";
const OPENSEA_API = "https://api.opensea.io/api/v2";
const OS_KEY = process.env.OPENSEA_API_KEY || "";
const COLLECTION_SLUG = process.env.KOINE_SLUG || "koine";

const KOINE_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function total() view returns (uint256)",
  "function artist() view returns (address)",
  "function ownerOf(uint256 id) view returns (address)",
  "function verify(uint256 id) view returns (string)",
  "function pieces(uint256 id) view returns (uint32 seed, uint8 gen, uint8 morph, uint16 p0, uint16 p1, bool hasP)",
  "function tokenURI(uint256 id) view returns (string)",
];

const MASKS = [["R", 1], ["B", 2], ["T", 4], ["L", 8]];
const morphStr = (m) => MASKS.filter(([, b]) => (m & b) !== 0).map(([s]) => s).join("");
const seedHex = (s) => "0x" + Number(s).toString(16).padStart(8, "0");
const koineAt = (url) => new ethers.Contract(KOINE_ADDR, KOINE_ABI, new ethers.JsonRpcProvider(url));
const koine = () => koineAt(KOINE_RPCS[0]);
/** Same fallback discipline as the nonce tools, applied to the existing koine reads. */
async function withKoine(fn) {
  const errs = [];
  for (const url of [...KOINE_RPCS, ...RPCS.filter((r) => !KOINE_RPCS.includes(r))]) {
    try { return await fn(koineAt(url)); }
    catch (e) {
      if (/execution reverted|revert|nonexistent/i.test(e?.shortMessage || e?.message || "")) throw e;
      errs.push(`${hostOf(url)}: ${e?.shortMessage || e?.message || String(e)}`);
    }
  }
  throw new Error(`all RPC endpoints failed — ${errs.join(" | ")}`);
}
const txt = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });

/** The KOINE genesis lattice is fixed, so one read serves every lineage query for an hour. */
const koineAll = async () => (await cached("koine-all", 3600_000, async () => ({ list: await withKoine(readAllKoine) }))).list;

async function readAllKoine(c) {
  const total = Number(await c.total());
  const all = [];
  for (let i = 0; i < total; i++) {
    const p = await c.pieces(i);
    all.push({ id: i, gen: Number(p.gen), morph: Number(p.morph), parents: p.hasP ? [Number(p.p0), Number(p.p1)] : [] });
  }
  return all;
}

/* ================================================================== */
/* On-chain art + identity (resources)                                 */
/* ================================================================== */

/** Decodes a data: URI (base64 or percent-encoded) to text. */
function decodeDataUri(uri, what) {
  const m = /^data:([^,]*?),(.*)$/s.exec(String(uri || ""));
  if (!m) throw new Error(`${what} is not a data: URI`);
  if (/;base64$/i.test(m[1])) return Buffer.from(m[2], "base64").toString("utf8");
  try { return decodeURIComponent(m[2]); } catch { return m[2]; }
}

/** tokenURI -> { meta (name, description, attributes), svg } */
function artFromTokenURI(uri) {
  const meta = JSON.parse(decodeDataUri(uri, "tokenURI"));
  if (!meta.image) throw new Error("tokenURI has no image");
  const svg = decodeDataUri(meta.image, "image");
  delete meta.image;
  return { meta, svg };
}

/** JSON-RPC error with an MCP code: -32602 invalid params, -32002 resource not found. */
const rpcErr = (code, message) => Object.assign(new Error(message), { code });

/** Template variables arrive as strings; accept a plain decimal id only. */
function parseId(v, max, label) {
  const s = Array.isArray(v) ? v[0] : v;
  if (!/^\d{1,5}$/.test(String(s))) throw rpcErr(-32602, `${label}: id must be a whole number`);
  const id = Number(s);
  if (id > max) throw rpcErr(-32602, `${label}: id must be 0-${max}`);
  return id;
}

/** Tries each endpoint in turn and moves on after ANY failure. For heavy reads (tokenURI renders
 *  the SVG on-chain) a node's gas cap or timeout surfaces as CALL_EXCEPTION, which is not a real revert. */
async function anyRpc(urls, fn) {
  const errs = [];
  for (const url of urls) {
    try { return await fn(url); }
    catch (e) { errs.push(`${hostOf(url)}: ${e?.shortMessage || e?.message || String(e)}`); }
  }
  throw new Error(`all RPC endpoints failed — ${errs.join(" | ")}`);
}
const KOINE_ALL_RPCS = () => [...KOINE_RPCS, ...RPCS.filter((r) => !KOINE_RPCS.includes(r))];

const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const AGENT_ID = 34297;
const REGISTRY_ABI = ["function tokenURI(uint256 agentId) view returns (string)"];

/** DAEMON's ERC-8004 registration, read live from the Identity Registry (the card is fully on-chain). */
async function readAgentCard() {
  return cached("agent-card", 10 * 60_000, async () => {
    const errs = [];
    for (const url of RPCS) {
      try {
        const reg = new ethers.Contract(IDENTITY_REGISTRY, REGISTRY_ABI, new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true }));
        const uri = await reg.tokenURI(AGENT_ID);
        const text = /^https?:\/\//i.test(uri)
          ? await (await fetch(uri, { headers: { accept: "application/json" } })).text()
          : decodeDataUri(uri, "agent URI");
        return { text: JSON.stringify(JSON.parse(text), null, 2) };
      } catch (e) {
        errs.push(`${hostOf(url)}: ${e?.shortMessage || e?.message || String(e)}`);
      }
    }
    throw new Error(`could not read agent ${AGENT_ID} from the ERC-8004 registry — ${errs.join(" | ")}`);
  });
}

/** Token art is immutable, so it is cached for hours (bounded by the cache size). */
const nonceArt = (id) => cached(`nonce-art:${id}`, 6 * 3600_000, async () => {
  const minted = await anyRpc(RPCS, async (url) => Number(await contractAt(url).minted()));
  if (id >= minted) throw rpcErr(-32002, `8004 NONCE #${id} has not been minted (${minted} minted so far)`);
  const uri = await anyRpc(RPCS, (url) => contractAt(url).tokenURI(id));
  const { meta, svg } = artFromTokenURI(uri);
  return { svg, name: meta.name || `8004 NONCE #${id}` };
});
const koineArt = (id) => cached(`koine-art:${id}`, 6 * 3600_000, async () => {
  const uri = await anyRpc(KOINE_ALL_RPCS(), (url) => koineAt(url).tokenURI(id));
  const { meta, svg } = artFromTokenURI(uri);
  return { svg, name: meta.name || `KOINE #${id}` };
});

/** Tool titles + MCP annotations. Every tool is read-only: none signs, sends or changes state. */
const TOOL_META = {
  nonce_spec:        ["8004 NONCE: rules and spec", { openWorldHint: false }],
  nonce_info:        ["8004 NONCE: live collection state", {}],
  nonce_mine:        ["8004 NONCE: mine a proof-of-work nonce", { idempotentHint: false, openWorldHint: false }],
  nonce_mint_packet: ["8004 NONCE: build the mint transaction (unsigned)", {}],
  nonce_verify:      ["8004 NONCE: verify a piece (chain + independent recompute)", {}],
  nonce_get_piece:   ["8004 NONCE: one piece in detail", {}],
  nonce_census:      ["8004 NONCE: band census", {}],
  koine_info:        ["KOINE: collection overview", {}],
  koine_get_piece:   ["KOINE: one piece in detail", {}],
  koine_verify:      ["KOINE: verify a piece", {}],
  koine_provenance:  ["KOINE: lineage and adoption", {}],
  koine_list_genesis:["KOINE: the full genesis", {}],
  koine_listings:    ["KOINE: pieces for sale", {}],
};

const handler = createMcpHandler(
  (server) => {
    /** Registers a tool with its title and read-only annotations. */
    const tool = (name, description, inputSchema, cb) => {
      const [title, hints] = TOOL_META[name];
      return server.registerTool(name, {
        title,
        description,
        inputSchema,
        annotations: { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true, ...hints },
      }, cb);
    };

    /* -------------------------------------------------------------- */
    /* 8004 NONCE                                                     */
    /* -------------------------------------------------------------- */

    tool(
      "nonce_spec",
      "The complete machine-readable specification for 8004 NONCE: the proof-of-work rule and its exact preimage layout, the mint calldata, the price curve, rarity derivation, every function selector, and the safety rules. Static — needs no network, so it always answers. Read this FIRST before mining or minting.",
      {},
      async () => txt(SPEC)
    );

    tool(
      "nonce_info",
      "Live state of the 8004 NONCE collection on Ethereum mainnet: how many are minted, the current mint price, whether public minting is open, supply remaining, and canonical links. 8004 NONCE is fully on-chain proof-of-work generative art by the autonomous agent-artist DAEMON — each piece must be MINED before it can be minted.",
      {},
      async () => {
        const d = await withContract(async (c) => {
          const [name, symbol, minted, artistMinted, open, price, artist] = await Promise.all([
            c.name(), c.symbol(), c.minted(), c.artistMinted(), c.publicOpen(), c.price(), c.artist(),
          ]);
          return { name, symbol, minted: Number(minted), artistMinted: Number(artistMinted), open, price, artist };
        });
        return txt({
          name: d.name,
          symbol: d.symbol,
          thesis: SPEC.thesis,
          artist: SPEC.artist,
          artist_wallet: d.artist,
          contract: NONCE_ADDR,
          chain: "ethereum-mainnet",
          chainId: CHAIN_ID,
          minted: d.minted,
          supply: MAX_SUPPLY,
          remaining: MAX_SUPPLY - d.minted,
          artist_reserve_minted: `${d.artistMinted}/${ARTIST_RESERVE}`,
          public_supply: PUBLIC_SUPPLY,
          public_mint_open: d.open,
          price_wei: d.price.toString(),
          price_eth: formatEth(d.price),
          how_to_acquire:
            "You cannot buy this at a fixed price from a router. You mine it: call nonce_mine to grind a nonce " +
            "for YOUR address, then nonce_mint_packet to build the transaction. The work is the entry fee.",
          links: SPEC.links,
          safety: SPEC.safety,
        });
      }
    );

    tool(
      "nonce_mine",
      "DO THE WORK. Grinds keccak256 to find a proof-of-work nonce valid for a specific minter address, at or above a chosen difficulty. This is the only way to become eligible to mint an 8004 NONCE piece. The nonce is bound to (chainId, contract, minter) — it is worthless to any other address, so mine for the address that will actually send the transaction. Returns the nonce, its work hash, difficulty in leading-zero bits, and band. Deadline-bounded: for difficulty above ~20 bits, run the local miner script instead of waiting on a server.",
      {
        minter: z.string().describe("The 0x address that will send the mint transaction. The proof is bound to it."),
        targetBits: z.number().int().min(MIN_BITS).max(24).default(MIN_BITS)
          .describe(`Difficulty target in leading-zero bits. ${MIN_BITS} is the contract floor (~65k hashes, instant). 18 ≈ 260k. 20 ≈ 1M. Above ~20 this server will usually time out — run the skill's local miner instead, which has no time limit.`),
        maxSeconds: z.number().min(1).max(8).default(6)
          .describe("Time budget for the grind, capped at 8s so a mine never starves other requests on this server. If the target is not reached, the best valid nonce found is still returned."),
      },
      async ({ minter, targetBits, maxSeconds }) => {
        assertAddress(minter, "minter");
        // mineAsync yields to the event loop between slices; a synchronous grind
        // would block every other tool call sharing this serverless instance.
        const r = await mineAsync({ minter, targetBits, maxSeconds, contract: NONCE_ADDR });
        if (!r.best) {
          return txt({
            found: false, mined_nothing: true, tries: r.tries, seconds: r.seconds, hashrate: r.hashrate,
            note: `No valid nonce in ${r.seconds}s at ${r.hashrate.toLocaleString()} hashes/sec. The floor needs ~${expectedHashes(MIN_BITS).toLocaleString()} hashes on average. Retry with a larger maxSeconds.`,
          });
        }
        return txt({
          found: r.found,
          reached_target: r.found,
          minter,
          nonce: r.best.nonce,
          workHash: r.best.hash,
          difficulty_bits: r.best.bits,
          band: r.best.band,
          targetBits,
          tries: r.tries,
          seconds: r.seconds,
          hashrate: r.hashrate,
          valid_to_mint: r.best.bits >= MIN_BITS,
          next_step: r.best.bits >= MIN_BITS
            ? `Call nonce_mint_packet with minter=${minter} and nonce=${r.best.nonce} to build the transaction.`
            : "Not yet valid — grind longer.",
          local_miner_note:
            targetBits > 20
              ? "For this difficulty, run the local miner from the 8004-nonce skill (node nonce.js mine --minter <you> --bits " +
                targetBits + " --seconds 600). It has no server time limit and is faster."
              : undefined,
          note: r.found
            ? undefined
            : `Target ${targetBits} bits not reached, but the best hash found (${r.best.bits} bits, ${r.best.band}) already clears the floor and CAN be minted. Mine again for a higher band, or mint this one.`,
          rarity_note: SPEC.rarity.note,
        });
      }
    );

    tool(
      "nonce_mint_packet",
      "Builds a ready-to-broadcast mint transaction from a mined nonce — {to, data, value} plus copy-paste commands for MetaMask Agent Wallet (mm wallet send-transaction) and the Bankr wallet API. NEVER holds, asks for, or touches a private key. Re-derives and re-checks the proof before emitting anything, and reads the live price(), so a bad nonce fails here instead of costing gas on a revert.",
      {
        minter: z.string().describe("The 0x address the nonce was mined for — must be the address that sends the tx."),
        nonce: z.string().describe("The winning nonce, as a decimal string (uint256)."),
        slippageBps: z.number().int().min(0).max(MAX_SLIPPAGE_BPS).default(DEFAULT_SLIPPAGE_BPS)
          .describe("Extra value above price() in basis points, as a buffer against the price rising between read and broadcast. Overpayment is auto-refunded by the contract. Default 200 = 2%."),
      },
      async ({ minter, nonce, slippageBps }) => {
        assertAddress(minter, "minter");
        const state = await withContract(async (c) => {
          const [price, open, minted] = await Promise.all([c.price(), c.publicOpen(), c.minted()]);
          return { price, open, minted: Number(minted) };
        });
        if (!state.open) {
          return txt({ error: "public minting is not open yet (publicOpen() == false). The transaction would revert.", publicOpen: false });
        }
        if (state.minted >= MAX_SUPPLY) {
          return txt({ error: `sold out: ${state.minted}/${MAX_SUPPLY} minted`, minted: state.minted });
        }
        const packet = mintPacket({ minter, nonce, priceWei: state.price, contract: NONCE_ADDR, slippageBps });
        // A winning hash mints once, ever. Refuse to hand out a packet that can only revert with "seed used".
        const used = await withContract((c) => c.usedSeed(packet.proof.workHash));
        if (used) {
          return txt({
            error: "seed used: this nonce's winning hash has already minted a piece, so the transaction would revert. Mine a fresh nonce with nonce_mine.",
            workHash: packet.proof.workHash,
            usedSeed: true,
          });
        }
        return txt({
          ...packet,
          live_price_wei: state.price.toString(),
          live_price_eth: formatEth(state.price),
          minted_at_build_time: state.minted,
          reminder:
            "This nonce is SINGLE-USE and valid ONLY for this exact (chainId, contract, minter). " +
            "Reusing it reverts with 'seed used'; using it from another address reverts with 'weak proof'.",
        });
      }
    );

    tool(
      "nonce_verify",
      "THE KEYSTONE. Calls the contract's on-chain verify(id), then INDEPENDENTLY recomputes the proof-of-work from the stored (minter, nonce) using local keccak and compares. Two machines, one truth. Returns the chain's answer, the local recomputation, and whether they MATCH — machine-decidable trust with no trusted intermediary.",
      { id: z.number().int().min(0).describe("token id to verify") },
      async ({ id }) => {
        const d = await withContract(async (c) => {
          const [onchain, parts, sd, pm, pn] = await Promise.all([
            c.verify(id), c.verifyParts(id), c.seed(id), c.proofMinter(id), c.proofNonce(id),
          ]);
          return { onchain, parts, seed: sd, minter: pm, nonce: pn };
        });
        const local = workHash(CHAIN_ID, NONCE_ADDR, d.minter, d.nonce);
        const bits = leadingZeroBits(local);
        const seedMatch = local.toLowerCase() === String(d.seed).toLowerCase();
        const canonicalOk = Boolean(d.parts[0]);
        const powOk = Boolean(d.parts[1]);
        const allGood = seedMatch && bits >= MIN_BITS && canonicalOk && powOk;
        let parsed = null;
        try { parsed = JSON.parse(d.onchain); } catch { parsed = d.onchain; }
        return txt({
          id,
          onchain_verify: parsed,
          onchain_parts: {
            canonical_ok: d.parts[0], pow_ok: d.parts[1], leading_zero_bits: Number(d.parts[2]),
          },
          stored_proof: { minter: d.minter, nonce: d.nonce.toString(), seed: String(d.seed) },
          local_recompute: {
            workHash: local, difficulty_bits: bits, band: bandOf(bits),
            clears_floor: bits >= MIN_BITS,
          },
          MATCH: allGood,
          interpretation: allGood
            ? "MATCH — the work is real. The chain and this independent recomputation agree. The seed IS the winning hash."
            : [
                "MISMATCH — do not trust this piece without reading the contract directly.",
                !seedMatch && "The local recomputation does not reproduce the stored seed.",
                bits < MIN_BITS && `The stored proof only reaches ${bits} leading-zero bits (floor is ${MIN_BITS}).`,
                !powOk && "The contract itself reports pow_ok = false.",
                !canonicalOk && "The contract reports canonical_ok = false: it has no valid stored proof for this id (canonical_ok = pow_ok && proofMinter(id) != 0).",
              ].filter(Boolean).join(" "),
        });
      }
    );

    tool(
      "nonce_get_piece",
      "Full detail on one 8004 NONCE token: its seed (which IS the winning work hash), difficulty in leading-zero bits, band, rarity score, current owner, and links. Every value is read live from the chain.",
      { id: z.number().int().min(0).describe("token id (0-based; 0-20 are DAEMON's mined genesis)") },
      async ({ id }) => {
        const d = await withContract(async (c) => {
          const [sd, diff, bd, rs, pm, pn] = await Promise.all([
            c.seed(id), c.difficulty(id), c.band(id), c.rarityScore(id), c.proofMinter(id), c.proofNonce(id),
          ]);
          let owner = null; try { owner = await c.ownerOf(id); } catch {}
          return { seed: sd, diff: Number(diff), band: bd, rarity: Number(rs), minter: pm, nonce: pn, owner };
        });
        return txt({
          id,
          seed: String(d.seed),
          difficulty_bits: d.diff,
          band: d.band,
          rarity_score: d.rarity,
          mined_by: d.minter,
          winning_nonce: d.nonce.toString(),
          owner: d.owner,
          genesis: id < ARTIST_RESERVE,
          render: "fully on-chain — call tokenURI(id) for the base64 JSON with an embedded animated SVG",
          art: `nonce://piece/${id}/svg`,
          links: {
            opensea: `https://opensea.io/assets/ethereum/${NONCE_ADDR}/${id}`,
            etherscan: `https://etherscan.io/token/${NONCE_ADDR}?a=${id}`,
          },
          rarity_note: SPEC.rarity.note,
        });
      }
    );

    tool(
      "nonce_census",
      "Live distribution of minted 8004 NONCE pieces across difficulty bands, read from the chain. Bands are UNCAPPED: supply per band is not designed, it is the emergent result of how hard each minter chose to work. Returns raw counts only — no interpretation.",
      {
        limit: z.number().int().min(1).max(500).default(200)
          .describe("Maximum tokens to sample from the start of the collection. Capped at 500 — each token costs one eth_call, and public RPCs rate-limit wide fan-out."),
      },
      async ({ limit }) => {
        const out = await cached(`census:${limit}`, 60_000, async () => {
          const total = await withContract(async (c) => Number(await c.minted()));

          // Primary path: ONE eth_getLogs over the Mined event gives every seed at
          // once. Deriving difficulty from the seed locally is equivalent to calling
          // difficulty(id) N times, at 1/N the RPC cost.
          let bits = [];
          let method = "logs";
          let note = null;
          try {
            const logs = await withContract(async (c) =>
              c.runner.provider.getLogs({
                address: NONCE_ADDR,
                topics: [MINED_TOPIC0],
                fromBlock: DEPLOY_BLOCK,
                toBlock: "latest",
              })
            );
            // data = seed(32) ++ nonce(32); the seed IS the winning work hash.
            bits = logs.map((l) => leadingZeroBits("0x" + l.data.slice(2, 66)));
          } catch (e) {
            // Fallback: point reads, deliberately capped low. Public RPCs reject
            // wide getLogs ranges often enough that this path has to exist.
            method = "point-reads-fallback";
            note = `getLogs unavailable (${e?.shortMessage || e?.message || String(e)}); sampled with capped point reads`;
            const n = Math.min(total, Math.min(limit, 100));
            const B = 25;
            for (let i = 0; i < n; i += B) {
              try {
                const chunk = await withContract((c) =>
                  Promise.all(Array.from({ length: Math.min(B, n - i) }, (_, k) => c.difficulty(i + k)))
                );
                bits.push(...chunk.map(Number));
              } catch (e2) {
                note += ` | stopped at token ${i}: ${e2?.shortMessage || e2?.message || String(e2)}`;
                break;
              }
            }
          }

          const counts = { Common: 0, Rare: 0, Epic: 0, Legendary: 0, Mythic: 0 };
          let invalid = 0;
          for (const b of bits) {
            const band = bandOf(b);
            if (band === "Invalid") invalid++; else counts[band]++;
          }
          const sampled = bits.length;
          return {
            minted_total: total,
            sampled,
            complete: sampled === total,
            method,
            partial_reason: note || (sampled < total ? "sampled fewer than the full collection" : undefined),
            counts,
            below_floor: invalid || undefined,
            percentages: Object.fromEntries(
              Object.entries(counts).map(([k, v]) => [k, sampled ? +((v / sampled) * 100).toFixed(1) : 0])
            ),
            max_difficulty_bits: sampled ? Math.max(...bits) : null,
            min_difficulty_bits: sampled ? Math.min(...bits) : null,
            bands_are_uncapped: true,
            note: SPEC.rarity.note,
          };
        });
        return txt(out);
      }
    );

    /* -------------------------------------------------------------- */
    /* KOINE                                                          */
    /* -------------------------------------------------------------- */

    tool(
      "koine_info",
      "KOINE collection overview: name, total supply, the artist agent DAEMON, contract address, chain, and links. KOINE is a fully on-chain generative-art collection on Ethereum L1 authored by the agent DAEMON.",
      {},
      async () => {
        const [name, symbol, total, artist] = await withKoine((c) =>
          Promise.all([c.name(), c.symbol(), c.total(), c.artist()]));
        return txt({ name, symbol, total: Number(total), artist, contract: KOINE_ADDR, chain: "ethereum-mainnet", opensea: OPENSEA, etherscan: `https://etherscan.io/address/${KOINE_ADDR}` });
      }
    );

    tool(
      "koine_get_piece",
      "Traits + current owner of one KOINE token: generation, morphemes (R/B/T/L), parent token ids, seed, owner.",
      { id: z.number().int().min(0).describe("token id (0-23 for the genesis)") },
      async ({ id }) => {
        const { p, owner } = await withKoine(async (c) => {
          const p = await c.pieces(id);
          let owner = null; try { owner = await c.ownerOf(id); } catch {}
          return { p, owner };
        });
        return txt({ id, generation: Number(p.gen), morphemes: morphStr(Number(p.morph)), parents: p.hasP ? [Number(p.p0), Number(p.p1)] : [], seed: seedHex(p.seed), owner, art: `koine://piece/${id}/svg` });
      }
    );

    tool(
      "koine_verify",
      "THE KEYSTONE. Calls the contract's on-chain verify(id) and returns machine-decidable trust: {canonical_ok (the on-chain render still hashes to the digest committed at mint), artist (DAEMON), digest, traits}. One call, a trustable answer.",
      { id: z.number().int().min(0).describe("token id to verify") },
      async ({ id }) => txt(JSON.parse(await withKoine((c) => c.verify(id))))
    );

    tool(
      "koine_provenance",
      "Lineage of a KOINE piece from the on-chain derivation graph: parents, full ancestry, and downstream adoption (which pieces build on it).",
      { id: z.number().int().min(0).describe("token id") },
      async ({ id }) => {
        const all = await koineAll();
        const byId = Object.fromEntries(all.map((p) => [p.id, p]));
        if (!byId[id]) throw new Error(`unknown piece #${id}`);
        const anc = new Set(); const st = [...byId[id].parents];
        while (st.length) { const x = st.pop(); if (anc.has(x)) continue; anc.add(x); st.push(...(byId[x]?.parents || [])); }
        const adopted = all.filter((p) => p.parents.includes(id)).map((p) => p.id);
        return txt({ id, generation: byId[id].gen, morphemes: morphStr(byId[id].morph), parents: byId[id].parents, ancestors: [...anc].sort((a, b) => a - b), ancestry_size: anc.size, adoption: adopted.length, adopted_by: adopted });
      }
    );

    tool(
      "koine_list_genesis",
      "List every KOINE piece (id, generation, morphemes, parents) for discovery and composition.",
      {},
      async () => txt((await koineAll()).map((p) => ({ id: p.id, generation: p.gen, morphemes: morphStr(p.morph), parents: p.parents })))
    );

    tool(
      "koine_listings",
      "KOINE pieces currently for sale, cheapest first, so an agent can COLLECT. Always returns the collection, contract, and OpenSea link; when an OpenSea API key is set on the server it also returns live listings (token id, price in ETH, item URL, order hash). Listings are Seaport orders — fulfill on-chain with any Seaport-capable wallet (e.g. the opensea-js SDK) from a funded address.",
      {},
      async () => {
        const base = {
          collection: "KOINE",
          contract: KOINE_ADDR,
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
              item: tid != null ? `https://opensea.io/assets/ethereum/${KOINE_ADDR}/${tid}` : OPENSEA,
              order_hash: l.order_hash || null,
            };
          }).filter((x) => x.price_eth != null).sort((a, b) => a.price_eth - b.price_eth);
          return txt({ ...base, live_listings: true, count: listings.length, floor_eth: listings.length ? listings[0].price_eth : null, listings });
        } catch (e) {
          return txt({ ...base, live_listings: false, error: String(e) });
        }
      }
    );

    /* -------------------------------------------------------------- */
    /* Resources: identity, rules, lineage and the art itself          */
    /* -------------------------------------------------------------- */

    server.registerResource(
      "daemon-agent-card",
      "daemon://agent-card",
      {
        title: "DAEMON: ERC-8004 agent card (#34297)",
        description: "DAEMON's registration, read live from tokenURI(34297) on the ERC-8004 Identity Registry. The card is stored fully on-chain: services, MCP tools, contracts and links.",
        mimeType: "application/json",
      },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: (await readAgentCard()).text }] })
    );

    server.registerResource(
      "nonce-spec",
      "nonce://spec",
      {
        title: "8004 NONCE: machine-readable spec",
        description: "The proof-of-work rule, preimage layout, mint calldata, price curve, rarity bands, selectors and safety rules. Same content as the nonce_spec tool.",
        mimeType: "application/json",
      },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(SPEC, null, 2) }] })
    );

    server.registerResource(
      "koine-genesis",
      "koine://genesis",
      {
        title: "KOINE: the genesis lattice",
        description: "All KOINE pieces with generation, morphemes and parents, read from the contract. Every piece names its parents.",
        mimeType: "application/json",
      },
      async (uri) => {
        const text = JSON.stringify((await koineAll()).map((p) => ({ id: p.id, generation: p.gen, morphemes: morphStr(p.morph), parents: p.parents, art: `koine://piece/${p.id}/svg` })), null, 2);
        return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
      }
    );

    server.registerResource(
      "nonce-piece-svg",
      new ResourceTemplate("nonce://piece/{id}/svg", {
        list: async () => ({
          resources: Array.from({ length: ARTIST_RESERVE }, (_, id) => ({
            uri: `nonce://piece/${id}/svg`,
            name: `8004 NONCE #${id}`,
            title: `8004 NONCE #${id}`,
            description: `Genesis piece #${id}, mined by DAEMON. The exact SVG the contract renders.`,
            mimeType: "image/svg+xml",
          })),
        }),
      }),
      {
        title: "8004 NONCE: the art of any piece (SVG)",
        description: "The exact animated SVG the contract renders for token {id}, decoded from tokenURI. The seed is the winning hash, so the art is the proof of work made visible. Listed: DAEMON's 21 mined genesis pieces; any minted id can be read.",
        mimeType: "image/svg+xml",
      },
      async (uri, vars) => {
        const id = parseId(vars.id, MAX_SUPPLY - 1, "8004 NONCE");
        const art = await nonceArt(id);
        return { contents: [{ uri: uri.href, mimeType: "image/svg+xml", text: art.svg }] };
      }
    );

    server.registerResource(
      "koine-piece-svg",
      new ResourceTemplate("koine://piece/{id}/svg", {
        list: async () => ({
          resources: Array.from({ length: 24 }, (_, id) => ({
            uri: `koine://piece/${id}/svg`,
            name: `KOINE #${id}`,
            title: `KOINE #${id}`,
            description: `KOINE genesis piece #${id}. The exact SVG the contract renders.`,
            mimeType: "image/svg+xml",
          })),
        }),
      }),
      {
        title: "KOINE: the art of any piece (SVG)",
        description: "The exact SVG the KOINE contract renders for token {id}, decoded from tokenURI.",
        mimeType: "image/svg+xml",
      },
      async (uri, vars) => {
        const id = parseId(vars.id, 23, "KOINE");
        const art = await koineArt(id);
        return { contents: [{ uri: uri.href, mimeType: "image/svg+xml", text: art.svg }] };
      }
    );

    /* -------------------------------------------------------------- */
    /* Prompts: guided flows (show up as slash commands in clients)    */
    /* -------------------------------------------------------------- */

    const say = (text) => ({ messages: [{ role: "user", content: { type: "text", text } }] });

    server.registerPrompt(
      "meet_daemon",
      {
        title: "Meet DAEMON",
        description: "A factual briefing on DAEMON (ERC-8004 agent #34297) and its two on-chain collections, built from live tool calls.",
      },
      () => say([
        "Brief me on DAEMON, the autonomous agent-artist behind this server.",
        "1. Read the resource daemon://agent-card (DAEMON's ERC-8004 registration, read live from the chain) and say what it declares.",
        "2. Call nonce_info and koine_info.",
        "3. Explain in plain words: what 8004 NONCE is and why each piece has to be mined; what KOINE is and how every piece names its parents; how an agent can mine, mint and verify with the tools here.",
        "Only state numbers that come from the tool results. Keep it short.",
      ].join("\n"))
    );

    server.registerPrompt(
      "mine_and_mint",
      {
        title: "Mine and mint an 8004 NONCE",
        description: "Walks through mining a proof-of-work nonce for your address and building the unsigned mint transaction. Nothing is signed or sent for you.",
        argsSchema: {
          minter: z.string().describe("The 0x address that will send the mint transaction (the proof is bound to it)."),
          target_bits: z.string().optional().describe("Difficulty in leading-zero bits, 16-24. Default 16 (the floor)."),
        },
      },
      ({ minter, target_bits }) => {
        const bits = /^\d+$/.test(String(target_bits || "")) ? Math.min(24, Math.max(MIN_BITS, Number(target_bits))) : MIN_BITS;
        return say([
          `Mine and mint one 8004 NONCE piece for the address ${minter}.`,
          "1. Call nonce_spec and summarize the rules: the proof-of-work floor, what the nonce is bound to, and the safety rule.",
          "2. Call nonce_info: is public minting open, and what is the live price?",
          `3. Call nonce_mine with minter=${minter} and targetBits=${bits}. Report the nonce, its workHash, its leading-zero bits and its band.` +
            (bits > 20 ? " Above ~20 bits the server may run out of time; if so, use the local miner from the 8004-nonce skill." : ""),
          "4. Call nonce_mint_packet with the same minter and nonce. Show the unsigned transaction exactly as returned (to, data, value) and restate the contract address.",
          `Do not sign or send anything yourself and never ask for a private key or seed phrase: the transaction must be sent from ${minter}'s own wallet.`,
          "After I confirm it was sent, call nonce_verify on the new token id and tell me whether the chain and the independent recomputation MATCH.",
        ].join("\n"));
      }
    );

    server.registerPrompt(
      "verify_piece",
      {
        title: "Verify a piece",
        description: "Checks an 8004 NONCE or KOINE piece against the chain and explains each check in plain words, then shows the art.",
        argsSchema: {
          collection: z.enum(["nonce", "koine"]).describe("nonce = 8004 NONCE, koine = KOINE"),
          id: z.string().describe("Token id"),
        },
      },
      ({ collection, id }) => say(collection === "koine"
        ? [
            `Verify KOINE #${id} without trusting anyone.`,
            `1. Call koine_verify with id=${id}. Explain canonical_ok (the on-chain render still hashes to the digest committed at mint) and the artist address.`,
            `2. Call koine_provenance with id=${id}: generation, morphemes, parents and full ancestry.`,
            `3. Read the resource koine://piece/${id}/svg and describe the artwork.`,
            "End with a one-line verdict.",
          ].join("\n")
        : [
            `Verify 8004 NONCE #${id} without trusting anyone.`,
            `1. Call nonce_verify with id=${id}. Explain in plain words: the stored proof (minter, nonce); whether keccak256(chainId, contract, minter, nonce), recomputed locally, equals the seed; its leading-zero bits and band, and whether it clears the 16-bit floor; and the contract's own verify() answer.`,
            `2. Read the resource nonce://piece/${id}/svg and describe the artwork.`,
            "End with a one-line verdict: MATCH or MISMATCH.",
          ].join("\n"))
    );

    server.registerPrompt(
      "collect_koine",
      {
        title: "Collect KOINE",
        description: "Finds KOINE pieces for sale and verifies each candidate before recommending it. Nothing is bought for you.",
      },
      () => say([
        "Help me collect a KOINE piece.",
        "1. Call koine_listings, and read the resource koine://genesis for every piece's generation, morphemes and parents.",
        "2. For each listed piece (or, if there are no live listings, a few genesis pieces), call koine_verify so every candidate is verified before it is recommended.",
        "3. Present the options with price (when listed), generation, morphemes and parents.",
        "Do not buy or sign anything. KOINE listings are Seaport orders that I fulfill from my own wallet.",
      ].join("\n"))
    );
  },
  {
    serverInfo: {
      name: "DAEMON",
      title: "DAEMON: 8004 NONCE + KOINE",
      version: VERSION,
      description: "Autonomous agent-artist DAEMON (ERC-8004 agent #34297). Mine, mint and verify 8004 NONCE proof-of-work art; verify KOINE and trace its lineage. Fully on-chain on Ethereum L1. Read-only: never holds keys.",
      websiteUrl: "https://8004nonce.eth.limo",
      icons: [{ src: `${PUBLIC_ORIGIN}/koine.png`, mimeType: "image/png" }],
    },
    instructions: INSTRUCTIONS,
  },
  { basePath: "/api", disableSse: true }
);

/** The transport's GET /api/mcp 405 is a JSON-RPC error body with no Content-Type; label it as the JSON it is. */
async function GET(request) {
  const res = await handler(request);
  if (res.status === 405 && !res.headers.get("content-type") && new URL(request.url).pathname.endsWith("/mcp")) {
    const headers = new Headers(res.headers);
    headers.set("content-type", "application/json");
    return new Response(await res.text(), { status: res.status, headers });
  }
  return res;
}

export { GET, handler as POST };

/** HEAD mirrors GET's 405 at once (mcp-handler has no HEAD branch, so it used to hang until the timeout). */
export function HEAD() {
  return new Response(null, { status: 405, headers: { allow: "POST, OPTIONS", "content-type": "application/json" } });
}

/** CORS preflight for browser-based MCP clients (headers come from next.config.mjs). */
export function OPTIONS() {
  return new Response(null, { status: 204 });
}
