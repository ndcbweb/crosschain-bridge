import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CONFIG, ENV } from "./config.js";
import { addTransfer, dueTransfers, markReleased, markRetry, readCursor, writeCursor } from "./db.js";

export const ARTIFACTS = JSON.parse(readFileSync(ENV.artifactsFile, "utf8"));
export const BRIDGE_ABI = ARTIFACTS.contracts.NadcabBridge.abi;
export const account = privateKeyToAccount(ENV.relayerKey);

const routeKeys = new Set(CONFIG.routes.map((route) => `${route.from}>${route.to}`));
const byId = new Map(CONFIG.chains.map((chain) => [chain.chainId, chain]));

/** Live status per chain, served by /api/health. */
export const status = new Map(
  CONFIG.chains.map((chain) => [chain.chainId, { head: null, cursor: null, balance: null, error: null, checkedAt: 0 }])
);

const clients = new Map(
  CONFIG.chains.map((chain) => {
    const viemChain = defineChain({
      id: chain.chainId,
      name: chain.name,
      nativeCurrency: { name: chain.symbol, symbol: chain.symbol, decimals: 18 },
      rpcUrls: { default: { http: [chain.rpcUrl] } },
    });
    const transport = http(chain.rpcUrl, { timeout: 20_000, retryCount: 1 });
    return [
      chain.chainId,
      {
        chain,
        read: createPublicClient({ chain: viemChain, transport }),
        write: createWalletClient({ chain: viemChain, transport, account }),
      },
    ];
  })
);

export const readClient = (chainId) => clients.get(Number(chainId))?.read || null;

function shortError(error) {
  return String(error?.shortMessage || error?.details || error?.message || error).split("\n")[0].slice(0, 300);
}

async function scanChain(chain) {
  const { read } = clients.get(chain.chainId);
  const state = status.get(chain.chainId);
  const head = Number(await read.getBlockNumber());
  state.head = head;
  const safe = head - ENV.confirmations;
  let cursor = readCursor(chain.chainId, chain.startBlock);
  while (cursor <= safe) {
    const to = Math.min(safe, cursor + ENV.logChunk - 1);
    const logs = await read.getContractEvents({
      address: chain.bridge,
      abi: BRIDGE_ABI,
      eventName: "Deposit",
      fromBlock: BigInt(cursor),
      toBlock: BigInt(to),
    });
    for (const log of logs) {
      const args = log.args;
      const dstChain = Number(args.dstChainId);
      addTransfer(
        {
          id: args.id,
          srcChain: chain.chainId,
          dstChain,
          nonce: Number(args.nonce),
          sender: args.sender.toLowerCase(),
          recipient: args.recipient.toLowerCase(),
          originChain: Number(args.originChainId),
          amount: args.amount.toString(),
          fee: args.fee.toString(),
          srcTx: log.transactionHash,
          srcBlock: Number(log.blockNumber),
        },
        routeKeys.has(`${chain.chainId}>${dstChain}`) && byId.has(dstChain) ? "pending" : "blocked"
      );
    }
    cursor = to + 1;
    writeCursor(chain.chainId, cursor);
  }
  state.cursor = cursor;
  state.balance = (await read.getBalance({ address: account.address })).toString();
  state.error = null;
  state.checkedAt = Date.now();
}

function wrappedLabel(originChainId) {
  const origin = byId.get(Number(originChainId));
  const symbol = origin?.symbol || "COIN";
  return { name: `Wrapped ${symbol} (${origin?.name || `Chain ${originChainId}`})`.slice(0, 60), symbol: `W${symbol}`.slice(0, 16) };
}

async function releaseOne(row) {
  const client = clients.get(Number(row.dst_chain));
  const already = await client.read.readContract({
    address: client.chain.bridge,
    abi: BRIDGE_ABI,
    functionName: "processed",
    args: [row.id],
  });
  if (already) {
    markReleased(row.id, row.dst_tx);
    return;
  }
  const label = wrappedLabel(row.origin_chain);
  const { request } = await client.read.simulateContract({
    account,
    address: client.chain.bridge,
    abi: BRIDGE_ABI,
    functionName: "release",
    args: [row.id, BigInt(row.src_chain), row.recipient, BigInt(row.origin_chain), BigInt(row.amount), label.name, label.symbol],
  });
  const hash = await client.write.writeContract(request);
  const receipt = await client.read.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`release ${hash} reverted`);
  markReleased(row.id, hash);
  console.log(`[relayer] released ${row.id} on ${row.dst_chain} in ${hash}`);
}

async function releasePending() {
  for (const row of dueTransfers()) {
    try {
      await releaseOne(row);
    } catch (error) {
      const message = shortError(error);
      console.error(`[relayer] ${row.id} → ${row.dst_chain}: ${message}`);
      markRetry(row.id, row.attempts, message);
    }
  }
}

let stopped = false;

export function startRelayer() {
  console.log(`[relayer] ${account.address} relaying ${CONFIG.routes.length} routes across ${CONFIG.chains.length} chains`);
  for (const chain of CONFIG.chains) {
    (async function loop() {
      while (!stopped) {
        try {
          await scanChain(chain);
        } catch (error) {
          const state = status.get(chain.chainId);
          state.error = shortError(error);
          state.checkedAt = Date.now();
          console.error(`[relayer] scan ${chain.chainId}: ${state.error}`);
        }
        await new Promise((resolve) => setTimeout(resolve, ENV.pollMs));
      }
    })();
  }
  (async function releaser() {
    while (!stopped) {
      await releasePending().catch((error) => console.error(`[relayer] release loop: ${shortError(error)}`));
      await new Promise((resolve) => setTimeout(resolve, Math.max(1000, ENV.pollMs / 2)));
    }
  })();
}

export function stopRelayer() {
  stopped = true;
}
