// Two anvil chains, a bridge on each and the bundled server as relayer: ETH goes A → B as a wrapped coin, then back.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const APP_DIR = process.argv[2];
const ART = JSON.parse(readFileSync(join(APP_DIR, "artifacts/nadcab-bridge.json"), "utf8"));
const BRIDGE = ART.contracts.NadcabBridge;
const TOKEN_ABI = ART.contracts.BridgedToken.abi;
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const USER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const RELAYER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const CHAINS = [
  { chainId: 1111, port: 18611, name: "Alpha", symbol: "ALP" },
  { chainId: 2222, port: 18622, name: "Beta", symbol: "BET" },
];
const APP_PORT = 14411;
const work = mkdtempSync(join(tmpdir(), "bridge-e2e-"));
const children = [];
const cleanup = () => children.forEach((child) => child.kill());
process.on("exit", cleanup);

function fail(message) {
  console.error(`FAIL: ${message}`);
  try {
    console.error(readFileSync(join(work, "server.log"), "utf8").slice(-4000));
  } catch {}
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(label, check, seconds = 60) {
  for (let i = 0; i < seconds; i += 1) {
    const value = await check().catch(() => null);
    if (value) return value;
    await sleep(1000);
  }
  fail(`timed out waiting for ${label}`);
}

for (const chain of CHAINS) {
  const child = spawn("anvil", ["--port", String(chain.port), "--chain-id", String(chain.chainId), "--block-time", "1", "--silent"]);
  children.push(child);
  chain.rpcUrl = `http://127.0.0.1:${chain.port}`;
  const viemChain = defineChain({
    id: chain.chainId,
    name: chain.name,
    nativeCurrency: { name: chain.symbol, symbol: chain.symbol, decimals: 18 },
    rpcUrls: { default: { http: [chain.rpcUrl] } },
  });
  chain.read = createPublicClient({ chain: viemChain, transport: http(chain.rpcUrl) });
  chain.owner = createWalletClient({ chain: viemChain, transport: http(chain.rpcUrl), account: privateKeyToAccount(OWNER_KEY) });
  chain.user = createWalletClient({ chain: viemChain, transport: http(chain.rpcUrl), account: privateKeyToAccount(USER_KEY) });
}
await until("anvil", async () => {
  for (const chain of CHAINS) await chain.read.getChainId();
  return true;
});

const relayer = privateKeyToAccount(RELAYER_KEY).address;
for (const chain of CHAINS) {
  const other = CHAINS.find((item) => item !== chain).chainId;
  const hash = await chain.owner.deployContract({
    abi: BRIDGE.abi,
    bytecode: BRIDGE.bytecode,
    args: [0, relayer, 50, [BigInt(other)], "", "", 0n],
  });
  const receipt = await chain.read.waitForTransactionReceipt({ hash });
  chain.bridge = receipt.contractAddress;
  chain.startBlock = Number(receipt.blockNumber);
}

writeFileSync(
  join(work, "bridge.json"),
  JSON.stringify({
    name: "E2E Bridge",
    mode: "lock-mint",
    feeBps: 50,
    confirmations: 2,
    chains: CHAINS.map(({ chainId, name, symbol, rpcUrl, bridge, startBlock }) => ({ chainId, name, symbol, rpcUrl, bridge, startBlock })),
    routes: [
      { from: 1111, to: 2222 },
      { from: 2222, to: 1111 },
    ],
  })
);

const server = spawn("node", ["--experimental-sqlite", "--no-warnings", "src/index.js"], {
  cwd: join(APP_DIR, "server"),
  env: {
    ...process.env,
    CONFIG_FILE: join(work, "bridge.json"),
    RELAYER_PRIVATE_KEY: RELAYER_KEY,
    PORT: String(APP_PORT),
    DATA_DIR: join(work, "data"),
    POLL_MS: "1000",
  },
});
children.push(server);
const log = [];
server.stdout.on("data", (chunk) => log.push(chunk));
server.stderr.on("data", (chunk) => log.push(chunk));
setInterval(() => writeFileSync(join(work, "server.log"), Buffer.concat(log)), 500).unref();

const BASE = `http://127.0.0.1:${APP_PORT}`;
const getJson = async (path) => (await fetch(`${BASE}${path}`)).json();

const health = await until("health", async () => {
  const data = await getJson("/api/health");
  return data.ok && data.chains.every((chain) => chain.live) ? data : null;
});
if (health.relayer.toLowerCase() !== relayer.toLowerCase()) fail("health reports another relayer");
const config = await getJson("/api/config");
if (config.mode !== "lock-mint" || config.chains.length !== 2 || !config.selectors.bridgeNative) fail("bad /api/config");
const page = await fetch(`${BASE}/`);
if (!page.ok || !(await page.text()).includes("app.js")) fail("bridge page not served");

const [alpha, beta] = CHAINS;
const user = alpha.user.account.address;

// A → B: lock 1 ALP, expect 0.995 WALP minted on B.
const out = await alpha.user.writeContract({
  address: alpha.bridge,
  abi: BRIDGE.abi,
  functionName: "bridgeNative",
  args: [BigInt(beta.chainId), user],
  value: parseEther("1"),
});
await alpha.read.waitForTransactionReceipt({ hash: out });
const wrappedAddress = await until("wrapped token on Beta", async () => {
  const address = await beta.read.readContract({ address: beta.bridge, abi: BRIDGE.abi, functionName: "wrapped", args: [BigInt(alpha.chainId)] });
  return /^0x0{40}$/.test(address) ? null : address;
});
const minted = await until("mint on Beta", async () => {
  const balance = await beta.read.readContract({ address: wrappedAddress, abi: TOKEN_ABI, functionName: "balanceOf", args: [user] });
  return balance > 0n ? balance : null;
});
if (minted !== parseEther("0.995")) fail(`expected 0.995 minted, got ${minted}`);
const symbol = await beta.read.readContract({ address: wrappedAddress, abi: TOKEN_ABI, functionName: "symbol" });
if (symbol !== "WALP") fail(`wrapped symbol ${symbol}`);

const transfers = await until("transfer marked released", async () => {
  const data = await getJson(`/api/transfers?address=${user}`);
  return data.transfers?.[0]?.status === "released" ? data.transfers : null;
});
if (!transfers[0].dstTx) fail("released transfer has no destination tx");

// B → A: burn 0.5 WALP, expect 0.4975 ALP released on A.
await beta.read.waitForTransactionReceipt({
  hash: await beta.user.writeContract({ address: wrappedAddress, abi: TOKEN_ABI, functionName: "approve", args: [beta.bridge, parseEther("0.5")] }),
});
const before = await alpha.read.getBalance({ address: user });
await beta.read.waitForTransactionReceipt({
  hash: await beta.user.writeContract({
    address: beta.bridge,
    abi: BRIDGE.abi,
    functionName: "bridgeToken",
    args: [wrappedAddress, BigInt(alpha.chainId), user, parseEther("0.5")],
  }),
});
const gained = await until("release on Alpha", async () => {
  const now = await alpha.read.getBalance({ address: user });
  return now > before ? now - before : null;
});
if (gained !== parseEther("0.4975")) fail(`expected 0.4975 back, got ${gained}`);

const rpcAnswer = await fetch(`${BASE}/api/rpc/1111`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ method: "eth_sendRawTransaction", params: ["0x00"] }),
});
if (rpcAnswer.status !== 400) fail("rpc proxy lets writes through");

console.log("e2e ok: lock → mint on Beta, burn → release on Alpha, API and page served");
process.exit(0);
