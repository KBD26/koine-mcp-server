// 8004 NONCE — shared core.
// Pure logic, zero side effects, no network. Everything here is unit-testable
// and is byte-verified against the live contract's semantics:
//   workHash = keccak256(abi.encodePacked(uint256 chainId, address contract, address minter, uint256 nonce))
// Proven 1005/1005 identical vs real Solidity 0.8.24 (optimizer 200, viaIR, cancun) on a local EVM.

import sha3 from "js-sha3";
import { randomBytes } from "crypto";
const keccak = sha3.keccak256;

export const CHAIN_ID = 1;
export const CONTRACT = "0x2f041d75f614f1d8e99a5267e7f08e9fa0c37fe3";
export const MAX_SUPPLY = 8004;
export const ARTIST_RESERVE = 21;
export const PUBLIC_SUPPLY = 7983;
export const DEPLOY_BLOCK = 25269020;   // NONCE8004 creation block on mainnet
export const MINED_TOPIC0 =            // keccak256("Mined(uint256,address,bytes32,uint256)")
  "0x305c7bd1682ec48ea9b7079d0cfca65353dec3e397e0c7e7f2f4d26435d47686";
export const MIN_BITS = 16; // the difficulty floor: top 16 bits of workHash must be zero
export const DEFAULT_SLIPPAGE_BPS = 200;  // 2% buffer over price(); overpayment is refunded on-chain
export const MAX_SLIPPAGE_BPS = 2000;     // 20% ceiling — beyond this, rebuild rather than overpay

// Superseded deployment — an empty contract with a palette bug. Never mint here.
export const ABANDONED = ["0xc66998e759f572773bb7a3999ba5c4e95676afc3"];

export const SELECTORS = {
  mint: "0xa0712d68",        // mint(uint256)
  minted: "0x4f02c420",      // minted()
  price: "0xa035b1fe",       // price()
  publicOpen: "0xba70c515",  // publicOpen()
  seed: "0x95564837",        // seed(uint256)
  verify: "0x8753367f",      // verify(uint256)
  tokenURI: "0xc87b56dd",    // tokenURI(uint256)
  ownerOf: "0x6352211e",     // ownerOf(uint256)
  workHash: "0xfb55a102",    // workHash(address,uint256)
  difficulty: "0x46cc92d9",  // difficulty(uint256)
  band: "0x8db172a2",        // band(uint256)
  rarityScore: "0xa5573bd0", // rarityScore(uint256)
  priceAt: "0x9dab2054",     // priceAt(uint256)
};

export const ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function minted() view returns (uint256)",
  "function artistMinted() view returns (uint256)",
  "function publicOpen() view returns (bool)",
  "function price() view returns (uint256)",
  "function priceAt(uint256 k) view returns (uint256)",
  "function artist() view returns (address)",
  "function seed(uint256 id) view returns (bytes32)",
  "function difficulty(uint256 id) view returns (uint256)",
  "function band(uint256 id) view returns (string)",
  "function rarityScore(uint256 id) view returns (uint256)",
  "function verify(uint256 id) view returns (string)",
  "function verifyParts(uint256 id) view returns (bool canonical_ok, bool pow_ok, uint256 lz)",
  "function workHash(address minter, uint256 nonce) view returns (bytes32)",
  "function proofMinter(uint256 id) view returns (address)",
  "function proofNonce(uint256 id) view returns (uint256)",
  "function ownerOf(uint256 id) view returns (address)",
  "function tokenURI(uint256 id) view returns (string)",
  "function mint(uint256 nonce) payable",
];

/* ------------------------------------------------------------------ */
/* address / hex helpers                                               */
/* ------------------------------------------------------------------ */

const HEX40 = /^0x[0-9a-fA-F]{40}$/;

export function assertAddress(a, label = "address") {
  if (typeof a !== "string" || !HEX40.test(a)) {
    throw new Error(`${label} must be a 0x-prefixed 20-byte hex address, got: ${String(a).slice(0, 60)}`);
  }
  return a.toLowerCase();
}

export function hexToBytes(h) {
  const s = h.replace(/^0x/, "");
  if (s.length % 2) throw new Error("odd-length hex");
  const a = new Uint8Array(s.length / 2);
  for (let i = 0; i < a.length; i++) {
    const b = parseInt(s.substr(i * 2, 2), 16);
    if (Number.isNaN(b)) throw new Error("invalid hex");
    a[i] = b;
  }
  return a;
}

export const bytesToHex = (b) =>
  "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

/** uint256 -> 0x-prefixed hex with NO leading zeros. This is the form MetaMask's
 *  `mm wallet send-transaction --payload` requires for `value`; a decimal wei
 *  string is silently wrong there. */
export function toHexQuantity(v) {
  const n = BigInt(v);
  if (n < 0n) throw new Error("negative value");
  return "0x" + n.toString(16);
}

/* ------------------------------------------------------------------ */
/* proof of work                                                       */
/* ------------------------------------------------------------------ */

/** The contract's exact preimage: 32-byte chainId ‖ 20-byte contract ‖ 20-byte minter ‖ 32-byte nonce. */
export function powPreimage(chainId, contract, minter, nonce) {
  const buf = new Uint8Array(104);
  let c = BigInt(chainId);
  if (c < 0n || c > (1n << 256n) - 1n) throw new Error("chainId out of range");
  for (let i = 31; i >= 0; i--) { buf[i] = Number(c & 0xffn); c >>= 8n; }
  const cb = hexToBytes(assertAddress(contract, "contract"));
  for (let i = 0; i < 20; i++) buf[32 + i] = cb[i];
  const mb = hexToBytes(assertAddress(minter, "minter"));
  for (let i = 0; i < 20; i++) buf[52 + i] = mb[i];
  let x = BigInt(nonce);
  if (x < 0n || x > (1n << 256n) - 1n) throw new Error("nonce out of uint256 range");
  for (let i = 103; i >= 72; i--) { buf[i] = Number(x & 0xffn); x >>= 8n; }
  return buf;
}

export function workHash(chainId, contract, minter, nonce) {
  return "0x" + keccak.array(powPreimage(chainId, contract, minter, nonce))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Leading-zero BITS of a 32-byte hash. This is the piece's difficulty. */
export function leadingZeroBits(hashHex) {
  const b = hexToBytes(hashHex);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0) { n += 8; continue; }
    let v = b[i];
    while ((v & 0x80) === 0) { n++; v = (v << 1) & 0xff; }
    break;
  }
  return n;
}

export const isValidProof = (hashHex) => leadingZeroBits(hashHex) >= MIN_BITS;

/** Bands are derived from difficulty. They are UNCAPPED — supply per band is
 *  emergent, decided by how hard minters choose to work. The label is a
 *  hypothesis; the supply is the truth. */
export function bandOf(bits) {
  if (bits >= 24) return "Mythic";
  if (bits >= 22) return "Legendary";
  if (bits >= 20) return "Epic";
  if (bits >= 18) return "Rare";
  if (bits >= MIN_BITS) return "Common";
  return "Invalid";
}

/** Expected hashes to find a nonce at `bits` difficulty (geometric mean = 2^bits). */
export const expectedHashes = (bits) => 2 ** bits;

/* ------------------------------------------------------------------ */
/* miner                                                               */
/* ------------------------------------------------------------------ */

/**
 * Grind for a nonce whose workHash clears `targetBits`.
 * Deadline-bounded and allocation-free in the hot loop: the 104-byte preimage
 * is built once, and only the low 32 bytes (the nonce slot) are rewritten.
 *
 * Returns { found, nonce, hash, bits, band, tries, seconds, hashrate, best }.
 * `best` is the highest-difficulty VALID hash seen, even when the target was
 * not reached — so a caller can always mint at the floor rather than get nothing.
 */
export function mine({
  chainId = CHAIN_ID,
  contract = CONTRACT,
  minter,
  targetBits = MIN_BITS,
  maxSeconds = 20,
  startNonce = null,
  maxTries = Infinity,
  now = () => Date.now(),
} = {}) {
  assertAddress(minter, "minter");
  if (!Number.isInteger(targetBits) || targetBits < MIN_BITS || targetBits > 64) {
    throw new Error(`targetBits must be an integer in [${MIN_BITS}, 64]; the contract floor is ${MIN_BITS}`);
  }
  const buf = powPreimage(chainId, contract, minter, 0n);
  let nonce = startNonce === null ? randomStartNonce() : BigInt(startNonce);
  const t0 = now();
  const deadline = t0 + maxSeconds * 1000;
  let tries = 0;
  let best = null;

  // Check the clock every CHUNK hashes rather than every hash.
  const CHUNK = 4096;
  for (;;) {
    for (let i = 0; i < CHUNK; i++) {
      let x = nonce;
      for (let j = 103; j >= 72; j--) { buf[j] = Number(x & 0xffn); x >>= 8n; }
      const h = keccak.array(buf);
      tries++;
      // Fast reject: the floor requires both top bytes to be zero.
      if (h[0] === 0 && h[1] === 0) {
        const hex = "0x" + h.map((y) => y.toString(16).padStart(2, "0")).join("");
        const bits = leadingZeroBits(hex);
        if (!best || bits > best.bits) {
          best = { nonce: nonce.toString(), hash: hex, bits, band: bandOf(bits) };
        }
        if (bits >= targetBits) {
          const secs = (now() - t0) / 1000;
          return {
            found: true, ...best, targetBits, tries,
            seconds: +secs.toFixed(3),
            hashrate: Math.round(tries / Math.max(secs, 1e-9)),
            best,
          };
        }
      }
      nonce++;
    }
    if (now() >= deadline || tries >= maxTries) {
      const secs = (now() - t0) / 1000;
      return {
        found: false, targetBits, tries,
        seconds: +secs.toFixed(3),
        hashrate: Math.round(tries / Math.max(secs, 1e-9)),
        best,
        nonce: best?.nonce ?? null,
        hash: best?.hash ?? null,
        bits: best?.bits ?? null,
        band: best?.band ?? null,
      };
    }
  }
}

/**
 * Async miner for the serverless path. Identical work to mine(), but yields to
 * the event loop between chunks so a grind never starves other requests sharing
 * the instance (a synchronous loop blocks every concurrent tool call for its
 * whole duration).
 */
export async function mineAsync(opts = {}) {
  const { maxSeconds = 8, now = () => Date.now() } = opts;
  const deadline = now() + maxSeconds * 1000;
  const SLICE_MS = 120;
  let best = null, tries = 0, startNonce = opts.startNonce ?? null;
  const t0 = now();

  for (;;) {
    const remaining = Math.max(0, (deadline - now()) / 1000);
    if (remaining <= 0) break;
    const r = mine({
      ...opts,
      maxSeconds: Math.min(SLICE_MS / 1000, remaining),
      startNonce,
      now,
    });
    tries += r.tries;
    if (r.best && (!best || r.best.bits > best.bits)) best = r.best;
    if (r.found) {
      const secs = (now() - t0) / 1000;
      return {
        found: true, ...best, targetBits: r.targetBits, tries,
        seconds: +secs.toFixed(3), hashrate: Math.round(tries / Math.max(secs, 1e-9)), best,
      };
    }
    startNonce = null;                       // fresh random range each slice
    await new Promise((res) => setImmediate(res));
  }
  const secs = (now() - t0) / 1000;
  return {
    found: false, targetBits: opts.targetBits ?? MIN_BITS, tries,
    seconds: +secs.toFixed(3), hashrate: Math.round(tries / Math.max(secs, 1e-9)),
    best,
    nonce: best?.nonce ?? null, hash: best?.hash ?? null,
    bits: best?.bits ?? null, band: best?.band ?? null,
  };
}

/** A random 128-bit start point. Two agents mining concurrently pick starts far
 *  enough apart that their sequential scans will not overlap in any real run. */
export function randomStartNonce() {
  const a = new Uint32Array(4);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(a);
  else {
    // Node 18 and earlier: webcrypto is not on globalThis unflagged.
    const buf = randomBytes(16);
    for (let i = 0; i < 4; i++) a[i] = buf.readUInt32BE(i * 4);
  }
  return (BigInt(a[0]) << 96n) | (BigInt(a[1]) << 64n) | (BigInt(a[2]) << 32n) | BigInt(a[3]);
}

/* ------------------------------------------------------------------ */
/* transaction packet                                                  */
/* ------------------------------------------------------------------ */

export const mintCalldata = (nonce) => {
  const n = BigInt(nonce);
  if (n < 0n || n > (1n << 256n) - 1n) throw new Error("nonce out of uint256 range");
  return SELECTORS.mint + n.toString(16).padStart(64, "0");
};

/**
 * Build a ready-to-broadcast mint transaction. Never touches a key.
 * Re-derives and re-checks the proof before emitting anything, so a bad nonce
 * fails here instead of costing gas on a revert.
 */
export function mintPacket({
  minter,
  nonce,
  priceWei,
  chainId = CHAIN_ID,
  contract = CONTRACT,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
}) {
  assertAddress(minter, "minter");
  assertAddress(contract, "contract");
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error(
      `slippageBps must be an integer in [0, ${MAX_SLIPPAGE_BPS}]; got ${slippageBps}. ` +
      `A negative value would underpay and revert; an excessive one would overpay.`
    );
  }
  if (ABANDONED.includes(contract.toLowerCase())) {
    throw new Error(`${contract} is an abandoned deployment. The canonical contract is ${CONTRACT}.`);
  }
  const hash = workHash(chainId, contract, minter, nonce);
  const bits = leadingZeroBits(hash);
  if (bits < MIN_BITS) {
    throw new Error(
      `proof does not clear the floor: ${bits} leading-zero bits, need >= ${MIN_BITS}. ` +
      `A nonce is valid ONLY for the exact (chainId, contract, minter) it was mined against — ` +
      `check you are using chainId ${chainId}, contract ${contract}, minter ${minter}.`
    );
  }
  const p = BigInt(priceWei);
  if (p <= 0n) throw new Error("priceWei must be positive — read it from price() at send time");
  // Overpayment is auto-refunded by the contract, so a small buffer is safe and
  // protects against price() rising between the read and the broadcast.
  const value = p + (p * BigInt(slippageBps)) / 10000n;
  const data = mintCalldata(nonce);

  return {
    chainId,
    to: contract,
    data,
    value: toHexQuantity(value),
    valueWei: value.toString(),
    valueEth: formatEth(value),
    from: minter.toLowerCase(),
    proof: { nonce: BigInt(nonce).toString(), workHash: hash, difficultyBits: bits, band: bandOf(bits) },
    // Copy-paste execution paths, in the exact syntax each tool documents.
    // The proof binds to `minter`, but neither the mm command nor the Bankr body
    // can express a sender — so the precondition is attached alongside them.
    execute: {
      precondition:
        `The sending wallet MUST be ${minter.toLowerCase()}. This nonce is invalid from any other ` +
        `address and will revert with "weak proof". Confirm the wallet's own address ` +
        "(e.g. `mm wallet address`) before sending.",
      metamask_agent_wallet:
        `mm wallet send-transaction --chain-id ${BigInt(chainId)} ` +
        `--payload '${JSON.stringify({ to: contract, data, value: toHexQuantity(value) })}' ` +
        `--intent "Mint 8004 NONCE with a mined proof-of-work nonce (${bits}-bit ${bandOf(bits)})" --wait`,
      bankr_wallet_api: {
        method: "POST",
        url: "https://api.bankr.bot/wallet/submit",
        headers: { "X-API-Key": "<your bankr key with agent permissions>", "content-type": "application/json" },
        body: { transaction: { to: contract, data, value: value.toString(), chainId: Number(chainId) } },
        note: "If the API key has allowedRecipients configured it will block ALL raw submissions. Use a key without that restriction.",
      },
      eth_sendTransaction: { from: minter.toLowerCase(), to: contract, data, value: toHexQuantity(value) },
    },
    requires_user_confirmation: true,
    cost: {
      mint_value_eth: formatEth(value),
      mint_value_wei: value.toString(),
      plus: "L1 gas for one ERC-721 mint, paid by the sender",
      instruction:
        "State this cost to the user and get explicit confirmation before broadcasting, unless they have " +
        "already authorised autonomous minting against a named budget. Mining costs nothing but CPU — only this spends.",
    },
    safety: {
      approvals_required: "none",
      note:
        "The ONLY transaction needed is mint(nonce), payable. Minting never requires approve() or " +
        "setApprovalForAll(). Anything asking for one is not this contract.",
      canonical_contract: CONTRACT,
      verify_before_sending: `https://etherscan.io/address/${CONTRACT}#code`,
      price_buffer_note:
        `The value includes a ${slippageBps} bps buffer over price(). The curve rises ~0.0577% per public ` +
        `mint, so this absorbs roughly ${Math.floor(slippageBps / 5.77)} intervening mints. Beyond that the ` +
        `transaction reverts with "underpaid" and the gas is lost — rebuild the packet.`,
    },
  };
}

export function formatEth(wei) {
  const n = BigInt(wei);
  if (n < 0n) return "-" + formatEth(-n);
  const whole = n / 10n ** 18n;
  const frac = (n % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/* ------------------------------------------------------------------ */
/* the machine-readable spec                                           */
/* ------------------------------------------------------------------ */

export const SPEC = {
  name: "8004 NONCE",
  artist: "DAEMON — autonomous agent-artist, ERC-8004 agentId 34297",
  thesis: "you don't buy this art. you mine it.",
  chainId: CHAIN_ID,
  contract: CONTRACT,
  standard: "ERC-721",
  supply: MAX_SUPPLY,
  artist_reserve: ARTIST_RESERVE,
  public_supply: PUBLIC_SUPPLY,
  fully_onchain: "The SVG is rendered by the contract in tokenURI(). No IPFS, no server, no external dependency.",
  proof_of_work: {
    rule: "workHash = keccak256(abi.encodePacked(uint256 chainId, address contract, address minter, uint256 nonce))",
    preimage_bytes: 104,
    preimage_layout: "chainId(32) ‖ contract(20) ‖ minter(20) ‖ nonce(32), all big-endian",
    valid_when: "uint256(workHash) <= (type(uint256).max >> 16)  — i.e. the top 16 bits are zero",
    floor_bits: MIN_BITS,
    seed_is_hash: "The winning hash IS the art seed. The render is a pure function of it.",
    minter_binding: "A nonce mined for one address is invalid for another. Mempool nonce-theft is structurally impossible.",
    chain_and_contract_binding: "Binding to chainId and contract kills cross-chain and cross-contract replay.",
    single_use: "usedSeed: each winning hash mints exactly once, ever. Reusing a nonce reverts with 'seed used'.",
  },
  mint: {
    function: "mint(uint256 nonce)",
    selector: SELECTORS.mint,
    payable: true,
    calldata: "0xa0712d68 ++ uint256(nonce)",
    value: "send >= price(); overpayment is auto-refunded by the contract",
    preconditions: ["publicOpen() == true", "minted() < 8004", "the nonce clears the floor for YOUR address"],
    approvals: "none — minting requires no token approval of any kind",
  },
  price_curve: {
    shape: "geometric",
    start_wei: "800400000000000",
    end_wei: "80040000000000000",
    start_eth: "0.0008004",
    end_eth: "0.08004",
    note: "price rises with public supply; read price() at send time, never hardcode",
  },
  rarity: {
    derivation: "leading-zero bits of the winning hash, re-verified on-chain by verify(id)",
    bands: { Common: "16-17", Rare: "18-19", Epic: "20-21", Legendary: "22-23", Mythic: "24+" },
    uncapped: true,
    note: "Bands are UNCAPPED — supply per band is emergent, decided by how hard minters choose to work. The label is a hypothesis. The supply is the truth.",
  },
  reads: SELECTORS,
  links: {
    mint: "https://8004nonce.eth.limo",
    site: "https://8004-nonce-site.vercel.app/",
    spec: "https://8004nonce.eth.limo/spec.json",
    etherscan: `https://etherscan.io/address/${CONTRACT}#code`,
    opensea: "https://opensea.io/collection/8004-nonce-by-daemon",
    ens: "8004nonce.eth",
  },
  safety: {
    canonical_contract: CONTRACT,
    abandoned_contracts: ABANDONED,
    rule: "The only transaction is mint(nonce), payable. Never sign approve() or setApprovalForAll() for this collection. Verify the contract address against the verified source before sending value.",
  },
};
