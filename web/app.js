const $ = (id) => document.getElementById(id);
const ZERO = "0x0000000000000000000000000000000000000000";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SEL = { approve: "0x095ea7b3", balanceOf: "0x70a08231", allowance: "0xdd62ed3e" };
const MAX_UINT = (1n << 256n) - 1n;

let config = null;
let account = "";
let assets = [];
let pendingLocal = [];

/* ---------- encoding ---------- */

const word = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
const encUint = (value) => word(BigInt(value).toString(16));
const encAddr = (value) => word(String(value).toLowerCase());
const decodeUint = (hex) => (hex && hex !== "0x" ? BigInt(String(hex).slice(0, 66)) : 0n);
const decodeAddr = (hex) => (hex && hex.length >= 66 ? `0x${hex.slice(26, 66)}`.toLowerCase() : ZERO);
const hex = (n) => `0x${BigInt(n).toString(16)}`;

function parseAmount(text) {
  const value = String(text || "").trim();
  if (!/^\d*(\.\d{0,18})?$/.test(value) || value === "" || value === ".") return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole || "0") * 10n ** 18n + BigInt(fraction.padEnd(18, "0") || "0");
}

function formatAmount(value, max = 6) {
  const n = BigInt(value);
  const whole = n / 10n ** 18n;
  const fraction = (n % 10n ** 18n).toString().padStart(18, "0").slice(0, max).replace(/0+$/, "");
  return fraction ? `${whole.toLocaleString("en-US")}.${fraction}` : whole.toLocaleString("en-US");
}

const short = (value) => (value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "");

/* ---------- chain reads go through the bridge host ---------- */

async function rpc(chainId, method, params = []) {
  const res = await fetch(`/api/rpc/${chainId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || "Chain read failed");
  return data.result;
}

const call = (chainId, to, data) => rpc(chainId, "eth_call", [{ to, data }, "latest"]);
const chainOf = (chainId) => config.chains.find((chain) => chain.chainId === Number(chainId));

/* ---------- wallet ---------- */

function provider() {
  if (!window.ethereum) throw new Error("Install a browser wallet such as MetaMask to bridge");
  return window.ethereum;
}

async function wallet(method, params) {
  try {
    return await provider().request(params ? { method, params } : { method });
  } catch (error) {
    if (error?.code === 4001) throw new Error("You rejected the request in your wallet");
    throw new Error(error?.data?.message || error?.message || "Wallet request failed");
  }
}

async function connect() {
  const [address] = await wallet("eth_requestAccounts");
  setAccount(address);
}

function setAccount(address) {
  account = address ? address.toLowerCase() : "";
  $("connect").textContent = account ? short(account) : "Connect wallet";
  $("recipient").placeholder = account || "Your connected wallet";
  refreshBalance();
  refreshHistory();
  updateQuote();
}

async function ensureChain(chainId) {
  const target = hex(chainId);
  if ((await wallet("eth_chainId")).toLowerCase() === target) return;
  try {
    await provider().request({ method: "wallet_switchEthereumChain", params: [{ chainId: target }] });
  } catch (error) {
    if (error?.code === 4001) throw new Error("You rejected the network switch");
    const chain = chainOf(chainId);
    await wallet("wallet_addEthereumChain", [
      {
        chainId: target,
        chainName: chain.name,
        rpcUrls: [chain.rpcUrl],
        nativeCurrency: { name: chain.symbol, symbol: chain.symbol, decimals: 18 },
        ...(chain.explorerUrl ? { blockExplorerUrls: [chain.explorerUrl] } : {}),
      },
    ]);
  }
  if ((await wallet("eth_chainId")).toLowerCase() !== target) throw new Error(`Switch your wallet to ${chainOf(chainId).name}`);
}

async function waitReceipt(chainId, hash) {
  for (let i = 0; i < 300; i += 1) {
    const receipt = await rpc(chainId, "eth_getTransactionReceipt", [hash]).catch(() => null);
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error("The transaction reverted");
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("The transaction is still pending. Check your wallet.");
}

/* ---------- form ---------- */

function routesFrom(chainId) {
  return config.routes.filter((route) => route.from === Number(chainId)).map((route) => route.to);
}

function fill(select, items, selected) {
  select.innerHTML = "";
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    select.append(option);
  }
  if (items.some((item) => String(item.value) === String(selected))) select.value = selected;
}

function renderFrom(selected) {
  const sources = config.chains.filter((chain) => routesFrom(chain.chainId).length);
  fill($("from"), sources.map((chain) => ({ value: chain.chainId, label: chain.name })), selected);
}

function renderTo(selected) {
  const targets = routesFrom($("from").value).map(chainOf);
  fill($("to"), targets.map((chain) => ({ value: chain.chainId, label: chain.name })), selected);
}

async function loadAssets() {
  const from = chainOf($("from").value);
  const list = [];
  if (config.mode === "burn-mint") {
    const token = decodeAddr(await call(from.chainId, from.bridge, config.selectors.token).catch(() => "0x"));
    if (token !== ZERO) list.push({ kind: "token", address: token, symbol: config.tokenSymbol || "TOKEN", origin: 0 });
  } else {
    list.push({ kind: "native", symbol: from.symbol, origin: from.chainId });
    if (config.mode === "lock-mint") {
      for (const origin of config.chains) {
        if (origin.chainId === from.chainId) continue;
        const data = config.selectors.wrapped + encUint(origin.chainId);
        const token = decodeAddr(await call(from.chainId, from.bridge, data).catch(() => "0x"));
        if (token !== ZERO) list.push({ kind: "token", address: token, symbol: `W${origin.symbol}`, origin: origin.chainId });
      }
    }
  }
  assets = list;
  fill(
    $("asset"),
    list.map((asset, i) => ({ value: i, label: asset.kind === "native" ? `${asset.symbol} (native)` : `${asset.symbol} · ${short(asset.address)}` })),
    0
  );
  refreshBalance();
  updateQuote();
}

function currentAsset() {
  return assets[Number($("asset").value)] || null;
}

function receiveSymbol(asset, toId) {
  const to = chainOf(toId);
  if (config.mode === "burn-mint") return asset.symbol;
  if (config.mode === "pool") return to.symbol;
  const origin = chainOf(asset.origin);
  return Number(asset.origin) === Number(toId) ? to.symbol : `W${origin?.symbol || "COIN"}`;
}

let balanceWei = null;

async function refreshBalance() {
  balanceWei = null;
  $("balance").textContent = "—";
  const asset = currentAsset();
  if (!account || !asset) return;
  const chainId = $("from").value;
  try {
    balanceWei =
      asset.kind === "native"
        ? BigInt(await rpc(chainId, "eth_getBalance", [account, "latest"]))
        : decodeUint(await call(chainId, asset.address, SEL.balanceOf + encAddr(account)));
    $("balance").textContent = `${formatAmount(balanceWei)} ${asset.symbol}`;
  } catch {
    $("balance").textContent = "unavailable";
  }
}

function updateQuote() {
  const asset = currentAsset();
  const amount = parseAmount($("amount").value);
  const submit = $("submit");
  $("eta").textContent = `${config.confirmations} confirmations`;
  if (!asset || !amount) {
    $("receive").textContent = "—";
    $("fee").textContent = `${(config.feeBps / 100).toFixed(2)}%`;
  } else {
    const fee = (amount * BigInt(config.feeBps)) / 10_000n;
    $("receive").textContent = `${formatAmount(amount - fee)} ${receiveSymbol(asset, $("to").value)}`;
    $("fee").textContent = `${formatAmount(fee)} ${asset.symbol} (${(config.feeBps / 100).toFixed(2)}%)`;
  }
  if (!account) {
    submit.textContent = "Connect wallet";
    submit.disabled = false;
  } else {
    submit.textContent = `Bridge to ${chainOf($("to").value)?.name || "…"}`;
    submit.disabled = !asset || !amount;
  }
}

function say(text, tone = "") {
  const node = $("message");
  node.textContent = text;
  node.className = `message${tone ? ` is-${tone}` : ""}`;
}

async function submit() {
  if (!account) return connect().catch((error) => say(error.message, "bad"));
  const asset = currentAsset();
  const amount = parseAmount($("amount").value);
  const fromId = Number($("from").value);
  const toId = Number($("to").value);
  const recipient = ($("recipient").value.trim() || account).toLowerCase();
  if (!ADDRESS.test(recipient)) return say("Recipient must be a 0x address", "bad");
  if (!asset || !amount) return say("Enter an amount", "bad");
  if (balanceWei != null && amount > balanceWei) return say("Amount is more than your balance", "bad");
  const from = chainOf(fromId);
  const button = $("submit");
  button.disabled = true;
  try {
    say(`Switching your wallet to ${from.name}…`);
    await ensureChain(fromId);
    let hash;
    if (asset.kind === "native") {
      say("Confirm the bridge transaction in your wallet…");
      hash = await wallet("eth_sendTransaction", [
        { from: account, to: from.bridge, value: hex(amount), data: config.selectors.bridgeNative + encUint(toId) + encAddr(recipient) },
      ]);
    } else {
      const allowed = decodeUint(await call(fromId, asset.address, SEL.allowance + encAddr(account) + encAddr(from.bridge)));
      if (allowed < amount) {
        say(`Approve ${asset.symbol} for the bridge in your wallet…`);
        const approveHash = await wallet("eth_sendTransaction", [
          { from: account, to: asset.address, data: SEL.approve + encAddr(from.bridge) + encUint(MAX_UINT) },
        ]);
        say("Waiting for the approval to confirm…");
        await waitReceipt(fromId, approveHash);
      }
      say("Confirm the bridge transaction in your wallet…");
      hash = await wallet("eth_sendTransaction", [
        {
          from: account,
          to: from.bridge,
          data: config.selectors.bridgeToken + encAddr(asset.address) + encUint(toId) + encAddr(recipient) + encUint(amount),
        },
      ]);
    }
    pendingLocal.unshift({ srcTx: hash.toLowerCase(), srcChainId: fromId, dstChainId: toId, amount: amount.toString(), status: "confirming", recipient });
    renderHistory([]);
    say("Sent. Waiting for the transaction to confirm…");
    await waitReceipt(fromId, hash);
    say(`Deposited. The relayer releases funds on ${chainOf(toId).name} after ${config.confirmations} confirmations.`, "ok");
    $("amount").value = "";
    refreshBalance();
    refreshHistory();
  } catch (error) {
    say(error.message, "bad");
  } finally {
    updateQuote();
  }
}

/* ---------- history ---------- */

function explorerTx(chainId, hash) {
  const chain = chainOf(chainId);
  return chain?.explorerUrl && hash ? `${chain.explorerUrl}/tx/${hash}` : "";
}

let lastHistory = [];

function renderHistory(rows) {
  if (rows) lastHistory = rows;
  const known = new Set(lastHistory.map((row) => row.srcTx.toLowerCase()));
  pendingLocal = pendingLocal.filter((row) => !known.has(row.srcTx));
  const list = $("history");
  list.innerHTML = "";
  const all = [...pendingLocal, ...lastHistory];
  $("history-hint").textContent = account ? (all.length ? "" : "No transfers yet.") : "Connect a wallet to see them.";
  for (const row of all) {
    const li = document.createElement("li");
    const head = document.createElement("div");
    head.className = "row";
    const title = document.createElement("strong");
    title.textContent = `${formatAmount(row.amount)} · ${chainOf(row.srcChainId)?.name || row.srcChainId} → ${chainOf(row.dstChainId)?.name || row.dstChainId}`;
    const badge = document.createElement("span");
    badge.className = `badge ${row.status}`;
    badge.textContent = row.status === "pending" ? "relaying" : row.status;
    head.append(title, badge);
    li.append(head);
    const links = document.createElement("div");
    links.className = "row";
    for (const [label, chainId, hash] of [
      ["Source tx", row.srcChainId, row.srcTx],
      ["Release tx", row.dstChainId, row.dstTx],
    ]) {
      if (!hash) continue;
      const url = explorerTx(chainId, hash);
      const node = document.createElement(url ? "a" : "span");
      node.textContent = `${label} ${short(hash)}`;
      if (url) {
        node.href = url;
        node.target = "_blank";
        node.rel = "noreferrer";
      }
      links.append(node);
    }
    li.append(links);
    if (row.error && row.status === "pending") {
      const note = document.createElement("span");
      note.className = "muted";
      note.textContent = `Retrying: ${row.error}`;
      li.append(note);
    }
    list.append(li);
  }
}

async function refreshHistory() {
  if (!account) return renderHistory([]);
  const res = await fetch(`/api/transfers?address=${account}`).catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  if (data.ok) renderHistory(data.transfers);
}

/* ---------- boot ---------- */

async function boot() {
  const res = await fetch("/api/config");
  config = await res.json();
  document.title = config.name;
  $("bridge-name").textContent = config.name;
  $("bridge-title").textContent = config.name;
  $("relayer").textContent = config.relayer;
  const modeText = { "lock-mint": "Lock & mint", "burn-mint": "Burn & mint", pool: "Liquidity pool" }[config.mode];
  $("bridge-sub").textContent = `${modeText} across ${config.chains.map((chain) => chain.name).join(", ")}.`;

  renderFrom();
  renderTo();
  await loadAssets();

  $("from").addEventListener("change", () => {
    renderTo();
    loadAssets();
  });
  $("to").addEventListener("change", updateQuote);
  $("asset").addEventListener("change", () => {
    refreshBalance();
    updateQuote();
  });
  $("amount").addEventListener("input", updateQuote);
  $("max").addEventListener("click", () => {
    if (balanceWei == null) return;
    const asset = currentAsset();
    const keep = asset?.kind === "native" ? 10n ** 15n : 0n;
    $("amount").value = balanceWei > keep ? formatAmount(balanceWei - keep, 18).replace(/,/g, "") : "0";
    updateQuote();
  });
  $("swap").addEventListener("click", () => {
    const from = $("from").value;
    const to = $("to").value;
    if (!routesFrom(to).includes(Number(from))) return say("There is no route back in that direction", "bad");
    renderFrom(to);
    renderTo(from);
    loadAssets();
  });
  $("connect").addEventListener("click", () => connect().catch((error) => say(error.message, "bad")));
  $("submit").addEventListener("click", submit);

  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", (accounts) => setAccount(accounts[0] || ""));
    const accounts = await window.ethereum.request({ method: "eth_accounts" }).catch(() => []);
    if (accounts[0]) setAccount(accounts[0]);
  }
  updateQuote();
  setInterval(refreshHistory, 6000);
}

boot().catch((error) => say(`Could not load the bridge: ${error.message}`, "bad"));
