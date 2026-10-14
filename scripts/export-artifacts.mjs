#!/usr/bin/env node
// Writes artifacts/nadcab-bridge.json (ABI + creation bytecode) from the Foundry build, for the server and the Console.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "contracts/out");
const read = (file, name) => JSON.parse(readFileSync(join(out, file, `${name}.json`), "utf8"));

const bridge = read("NadcabBridge.sol", "NadcabBridge");
const token = read("BridgedToken.sol", "BridgedToken");
const payload = {
  name: "Nadcab Crosschain Bridge",
  compiler: bridge.metadata?.compiler?.version || "0.8.24",
  evmVersion: "paris",
  contracts: {
    NadcabBridge: { abi: bridge.abi, bytecode: bridge.bytecode.object },
    BridgedToken: { abi: token.abi },
  },
};
mkdirSync(join(root, "artifacts"), { recursive: true });
writeFileSync(join(root, "artifacts/nadcab-bridge.json"), `${JSON.stringify(payload)}\n`);
console.log("artifacts/nadcab-bridge.json: NadcabBridge, BridgedToken");
