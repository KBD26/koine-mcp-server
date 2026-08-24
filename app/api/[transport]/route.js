import { createMcpHandler } from "mcp-handler";
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

/* ================================================================== */
/* RPC — multiple endpoints, first one that answers wins               */
/* ================================================================== */

// Endpoints below were each verified against price() on mainnet, 5/5 trials, Aug 2026.
// Removed: eth.llamarpc.com (HTTP 521, dead), rpc.ankr.com/eth (now requires an API key),
// cloudflare-eth.com (answers eth_chainId but returns -32603 on eth_call).
const RPCS = (process.env.ETH_RPC || [
  "https://ethereum-rpc.publicnode.com",
  "https://gateway.tenderly.co/public/mainnet",
  "https://eth-mainnet.public.blastapi.io",
  "https://eth.api.onfinality.io/public",
  "https://eth-pokt.nodies.app",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);

const NONCE_ADDR = process.env.NONCE_ADDR || CONTRACT;

// Sticky preferred endpoint: a persistently dead RPC is skipped on later calls.
// Read once per invocation so concurrent requests cannot interleave their rotation.
let _rpcPref = 0;

const contractAt = (url) =>
  new ethers.Contract(NONCE_ADDR, ABI, new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true }));

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
      errs.push(`${RPCS[idx]}: ${e?.shortMessage || e?.message || String(e)}`);
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
      errs.push(`${url}: ${e?.shortMessage || e?.message || String(e)}`);
    }
  }
  throw new Error(`all RPC endpoints failed — ${errs.join(" | ")}`);
}
const txt = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });

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

const handler = createMcpHandler(
  (server) => {
    /* -------------------------------------------------------------- */
    /* 8004 NONCE                                                     */
    /* -------------------------------------------------------------- */

    server.tool(
      "nonce_spec",
      "The complete machine-readable specification for 8004 NONCE: the proof-of-work rule and its exact preimage layout, the mint calldata, the price curve, rarity derivation, every function selector, and the safety rules. Static — needs no network, so it always answers. Read this FIRST before mining or minting.",
      {},
      async () => txt(SPEC)
    );

    server.tool(
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

    server.tool(
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

    server.tool(
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

    server.tool(
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
                !canonicalOk && "The contract reports canonical_ok = false: the on-chain render no longer matches what was committed at mint.",
              ].filter(Boolean).join(" "),
        });
      }
    );

    server.tool(
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
          links: {
            opensea: `https://opensea.io/assets/ethereum/${NONCE_ADDR}/${id}`,
            etherscan: `https://etherscan.io/token/${NONCE_ADDR}?a=${id}`,
          },
          rarity_note: SPEC.rarity.note,
        });
      }
    );

    server.tool(
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

    server.tool(
      "koine_info",
      "KOINE collection overview: name, total supply, the artist agent DAEMON, contract address, chain, and links. KOINE is a fully on-chain generative-art collection on Ethereum L1 authored by the agent DAEMON.",
      {},
      async () => {
        const [name, symbol, total, artist] = await withKoine((c) =>
          Promise.all([c.name(), c.symbol(), c.total(), c.artist()]));
        return txt({ name, symbol, total: Number(total), artist, contract: KOINE_ADDR, chain: "ethereum-mainnet", opensea: OPENSEA, etherscan: `https://etherscan.io/address/${KOINE_ADDR}` });
      }
    );

    server.tool(
      "koine_get_piece",
      "Traits + current owner of one KOINE token: generation, morphemes (R/B/T/L), parent token ids, seed, owner.",
      { id: z.number().int().min(0).describe("token id (0-23 for the genesis)") },
      async ({ id }) => {
        const { p, owner } = await withKoine(async (c) => {
          const p = await c.pieces(id);
          let owner = null; try { owner = await c.ownerOf(id); } catch {}
          return { p, owner };
        });
        return txt({ id, generation: Number(p.gen), morphemes: morphStr(Number(p.morph)), parents: p.hasP ? [Number(p.p0), Number(p.p1)] : [], seed: seedHex(p.seed), owner });
      }
    );

    server.tool(
      "koine_verify",
      "THE KEYSTONE. Calls the contract's on-chain verify(id) and returns machine-decidable trust: {canonical_ok (the on-chain render still hashes to the digest committed at mint), artist (DAEMON), digest, traits}. One call, a trustable answer.",
      { id: z.number().int().min(0).describe("token id to verify") },
      async ({ id }) => txt(JSON.parse(await withKoine((c) => c.verify(id))))
    );

    server.tool(
      "koine_provenance",
      "Lineage of a KOINE piece from the on-chain derivation graph: parents, full ancestry, and downstream adoption (which pieces build on it).",
      { id: z.number().int().min(0).describe("token id") },
      async ({ id }) => {
        const all = await withKoine(readAllKoine);
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
      async () => txt((await withKoine(readAllKoine)).map((p) => ({ id: p.id, generation: p.gen, morphemes: morphStr(p.morph), parents: p.parents })))
    );

    server.tool(
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
  },
  {},
  { basePath: "/api" }
);

export { handler as GET, handler as POST };
