import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { toFunctionSelector } from "viem";
import { CONFIG, ENV } from "./config.js";
import { getTransfer, listTransfers, transferCounts } from "./db.js";
import { account, BRIDGE_ABI, readClient, startRelayer, status } from "./relayer.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const STALE_MS = 5 * 60_000;
const READ_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getTransactionReceipt",
]);

const app = Fastify({ trustProxy: "127.0.0.1", logger: { level: "info" }, disableRequestLogging: true, bodyLimit: 64 * 1024 });
app.setReplySerializer((payload) => JSON.stringify(payload, (key, value) => (typeof value === "bigint" ? value.toString() : value)));

app.addHook("onSend", async (request, reply, payload) => {
  reply.header(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"
  );
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "strict-origin-when-cross-origin");
  return payload;
});

await app.register(rateLimit, {
  global: true,
  max: 600,
  timeWindow: "1 minute",
  allowList: (request) => request.url === "/api/health",
});

app.setErrorHandler((error, request, reply) => {
  reply.code(error.statusCode || 500).send({ ok: false, error: error.message || "Request failed" });
});

const selectors = Object.fromEntries(
  ["bridgeNative", "bridgeToken", "wrapped", "token", "originOf", "poolLiquidity", "feeBps", "paused"].map((name) => [
    name,
    toFunctionSelector(BRIDGE_ABI.find((item) => item.type === "function" && item.name === name)),
  ])
);

app.get("/api/config", async () => ({
  ok: true,
  name: CONFIG.name,
  mode: CONFIG.mode,
  feeBps: CONFIG.feeBps,
  confirmations: ENV.confirmations,
  relayer: account.address,
  tokenSymbol: CONFIG.tokenSymbol,
  chains: CONFIG.chains.map(({ startBlock: _start, ...chain }) => chain),
  routes: CONFIG.routes,
  selectors,
}));

app.get("/api/health", async () => {
  const now = Date.now();
  const chains = CONFIG.chains.map((chain) => {
    const state = status.get(chain.chainId);
    return {
      chainId: chain.chainId,
      name: chain.name,
      symbol: chain.symbol,
      head: state.head,
      cursor: state.cursor,
      lag: state.head == null || state.cursor == null ? null : Math.max(0, state.head - state.cursor + 1),
      relayerBalance: state.balance,
      error: state.error,
      live: Boolean(state.checkedAt && now - state.checkedAt < STALE_MS && !state.error),
    };
  });
  return {
    ok: chains.some((chain) => chain.live),
    relayer: account.address,
    chains,
    transfers: transferCounts(),
  };
});

app.get("/api/transfers", async (request) => {
  const address = String(request.query.address || "").trim().toLowerCase();
  if (address && !ADDRESS.test(address)) return { ok: false, error: "address must be a 0x address" };
  const limit = Math.max(1, Math.min(100, Number(request.query.limit) || 25));
  return { ok: true, transfers: listTransfers(address, limit) };
});

app.get("/api/transfers/:key", async (request, reply) => {
  const transfer = getTransfer(String(request.params.key || "").toLowerCase());
  if (!transfer) return reply.code(404).send({ ok: false, error: "Transfer not found yet" });
  return { ok: true, transfer };
});

/** Read-only JSON-RPC to the bridge's chains so the page can read balances without CORS issues. */
app.post("/api/rpc/:chainId", { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } }, async (request, reply) => {
  const client = readClient(request.params.chainId);
  if (!client) return reply.code(404).send({ ok: false, error: "Unknown chain" });
  const { method, params = [] } = request.body || {};
  if (!READ_METHODS.has(method)) return reply.code(400).send({ ok: false, error: "Method not allowed" });
  try {
    const result = await client.request({ method, params });
    return { ok: true, result };
  } catch (error) {
    return reply.code(502).send({ ok: false, error: String(error?.shortMessage || error?.message || "RPC error").slice(0, 300) });
  }
});

await app.register(fastifyStatic, { root: ENV.webDir, prefix: "/" });
app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith("/api/")) return reply.code(404).send({ ok: false, error: "Not found" });
  return reply.sendFile("index.html");
});

startRelayer();
await app.listen({ host: "0.0.0.0", port: ENV.port });
