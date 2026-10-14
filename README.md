# Nadcab Crosschain Bridge

Bridge endpoints, relayer and hosted bridge site for the Nadcab Console **Crosschain Bridge** droplet.

- `contracts/` holds `NadcabBridge` (one per chain) and `BridgedToken` (wrapped or canonical token minted by the bridge).
  - **Lock & mint**: the native coin is locked on its chain and minted as `W<SYMBOL>` elsewhere; sending it back burns it and unlocks the coin.
  - **Burn & mint**: one token on every chain, burned on the source and minted on the destination.
  - **Liquidity pool**: the native coin is paid out of a pool the owner funds on each chain.
- `server/` watches `Deposit` events, waits for the configured confirmations, then calls `release` on the destination with the relayer key. It serves the API and the page in `web/`.

## Run

```sh
CONFIG_FILE=bridge.json RELAYER_PRIVATE_KEY=0x… PORT=80 DATA_DIR=/data node --experimental-sqlite server/src/index.js
```

`bridge.json`:

```json
{
  "name": "My Bridge",
  "mode": "lock-mint",
  "feeBps": 30,
  "confirmations": 12,
  "chains": [{ "chainId": 1, "name": "Ethereum", "symbol": "ETH", "rpcUrl": "https://…", "explorerUrl": "https://etherscan.io", "bridge": "0x…", "startBlock": 0 }],
  "routes": [{ "from": 1, "to": 56 }]
}
```

The relayer wallet pays gas for releases, so it needs a little native coin on every destination chain.

## API

- `GET /api/health`: per-chain head, scan cursor, relayer balance
- `GET /api/config`: chains, routes, mode and fee for the page
- `GET /api/transfers?address=0x…`, `GET /api/transfers/:idOrSourceTx`
- `POST /api/rpc/:chainId`: read-only JSON-RPC (`eth_call`, `eth_getBalance`, …)

## Build

`forge test` in `contracts/`, `node scripts/export-artifacts.mjs`, `bash scripts/bundle.sh`, `bash test/e2e.sh`. Pushes to `main` publish `bridge.tar.gz` and `nadcab-bridge.json` to the `latest` release.
