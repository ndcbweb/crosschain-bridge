import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;
const here = dirname(fileURLToPath(import.meta.url));
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const clean = (value, fallback = "") => String(value ?? "").replace(/[\r\n]+/g, " ").trim() || fallback;
const MODES = { "lock-mint": 0, "burn-mint": 1, pool: 2 };

function fail(message) {
  throw new Error(`Bridge config: ${message}`);
}

/**
 * bridge.json (CONFIG_FILE) describes the chains and routes; secrets come from the environment.
 * { name, mode, feeBps, confirmations, chains: [{ chainId, name, symbol, rpcUrl, explorerUrl, bridge, startBlock }],
 *   routes: [{ from, to }] }
 */
function loadConfig() {
  const file = resolve(clean(env.CONFIG_FILE, "./bridge.json"));
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }
  if (!(raw.mode in MODES)) fail(`mode must be one of ${Object.keys(MODES).join(", ")}`);
  const chains = (raw.chains || []).map((chain) => {
    const chainId = Number(chain.chainId);
    if (!Number.isInteger(chainId) || chainId < 1) fail("every chain needs a chainId");
    if (!ADDRESS.test(String(chain.bridge || ""))) fail(`chain ${chainId} needs a bridge address`);
    if (!/^https?:\/\//.test(String(chain.rpcUrl || ""))) fail(`chain ${chainId} needs an http(s) rpcUrl`);
    return {
      chainId,
      name: clean(chain.name, `Chain ${chainId}`),
      symbol: clean(chain.symbol, "ETH"),
      rpcUrl: clean(chain.rpcUrl),
      explorerUrl: clean(chain.explorerUrl).replace(/\/+$/, ""),
      bridge: String(chain.bridge).toLowerCase(),
      startBlock: Math.max(0, Number(chain.startBlock) || 0),
    };
  });
  if (chains.length < 2) fail("at least two chains are required");
  const ids = new Set(chains.map((chain) => chain.chainId));
  const routes = (raw.routes || []).map((route) => ({ from: Number(route.from), to: Number(route.to) }));
  for (const route of routes) {
    if (!ids.has(route.from) || !ids.has(route.to) || route.from === route.to) fail(`bad route ${route.from} → ${route.to}`);
  }
  if (!routes.length) fail("at least one route is required");
  return {
    name: clean(raw.name, "Crosschain Bridge"),
    mode: raw.mode,
    modeId: MODES[raw.mode],
    feeBps: Math.max(0, Math.min(1000, Number(raw.feeBps) || 0)),
    confirmations: Math.max(0, Math.min(256, Number(raw.confirmations ?? 12))),
    tokenSymbol: clean(raw.tokenSymbol).slice(0, 16),
    chains,
    routes,
  };
}

export const CONFIG = loadConfig();

export const ENV = {
  port: Number(env.PORT) || 4400,
  dataDir: resolve(clean(env.DATA_DIR, "./.data")),
  webDir: resolve(clean(env.WEB_DIR, join(here, "../../web"))),
  artifactsFile: resolve(clean(env.ARTIFACTS_FILE, join(here, "../../artifacts/nadcab-bridge.json"))),
  relayerKey: clean(env.RELAYER_PRIVATE_KEY),
  pollMs: Math.max(1000, Number(env.POLL_MS) || 6000),
  logChunk: Math.max(10, Number(env.LOG_CHUNK) || 2000),
  confirmations: env.CONFIRMATIONS == null || env.CONFIRMATIONS === "" ? CONFIG.confirmations : Math.max(0, Number(env.CONFIRMATIONS)),
};

if (!/^0x[0-9a-fA-F]{64}$/.test(ENV.relayerKey)) throw new Error("RELAYER_PRIVATE_KEY must be a 0x 32-byte hex key");

mkdirSync(ENV.dataDir, { recursive: true });
