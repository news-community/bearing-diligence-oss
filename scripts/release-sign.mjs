// The release key: make it once, sign each release's checksum list with it, and check the two halves
// agree. node:crypto only, so the release workflow can run it with any Node.
//
//   node scripts/release-sign.mjs keygen [private-key-file]
//       Makes an Ed25519 key. The private half goes to the file (default
//       ~/.config/bearing-diligence/release-signing-key.pem, mode 600, never overwritten); the public
//       half is written into src/download/release-key.ts, to be committed. Then:
//       gh secret set RELEASE_SIGNING_KEY -R news-community/bearing-diligence-oss < that-file
//
//   RELEASE_SIGNING_KEY=<pem> node scripts/release-sign.mjs check
//       Fails unless the secret's public half is the one compiled into the app. A release signed by
//       any other key would be refused by every installed copy.
//
//   RELEASE_SIGNING_KEY=<pem> node scripts/release-sign.mjs sign checksums.txt
//       Writes checksums.txt.sig: base64 of the raw 64-byte signature.
//
//   node scripts/release-sign.mjs verify checksums.txt checksums.txt.sig
//       Verifies against the compiled-in public half, as the app will.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY_TS = join(root, "src/download/release-key.ts");
const SPKI = Buffer.from("302a300506032b6570032100", "hex");

const committed = () => /RELEASE_PUBLIC_KEY = "([^"]*)"/.exec(readFileSync(KEY_TS, "utf8"))?.[1] ?? "";
const rawPublic = (pub) => pub.export({ format: "der", type: "spki" }).subarray(SPKI.length).toString("base64");
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
function secret() {
  const pem = process.env.RELEASE_SIGNING_KEY ?? "";
  if (!pem.trim()) fail("RELEASE_SIGNING_KEY is not set. It is the PEM private key made by `keygen`.");
  try {
    return createPrivateKey(pem);
  } catch (e) {
    fail(`RELEASE_SIGNING_KEY is not a readable private key: ${e.message}`);
  }
}
function publicFromCommitted() {
  const b64 = committed();
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 32) fail(`src/download/release-key.ts holds ${raw.length} bytes; an Ed25519 public key is 32. Run keygen first.`);
  return createPublicKey({ key: Buffer.concat([SPKI, raw]), format: "der", type: "spki" });
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "keygen") {
  const file = a ?? join(homedir(), ".config/bearing-diligence/release-signing-key.pem");
  if (existsSync(file)) fail(`${file} exists already; a release key is made once. Move it away first if you mean to replace it.`);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const ts = readFileSync(KEY_TS, "utf8").replace(/RELEASE_PUBLIC_KEY = "[^"]*"/, `RELEASE_PUBLIC_KEY = "${rawPublic(publicKey)}"`);
  writeFileSync(KEY_TS, ts);
  console.log(`private half: ${file} (mode 600). Keep it off any synced folder, and back it up offline.`);
  console.log("public half: written into src/download/release-key.ts. Commit it.");
  console.log(`then: gh secret set RELEASE_SIGNING_KEY -R news-community/bearing-diligence-oss < "${file}"`);
} else if (cmd === "check") {
  const mine = rawPublic(createPublicKey(secret()));
  if (mine !== committed()) fail("RELEASE_SIGNING_KEY is not the private half of the key compiled into the app, so every installed copy would refuse this release.");
  console.log("the release key matches the one compiled into the app");
} else if (cmd === "sign") {
  if (!a) fail("sign needs the checksum list");
  const sig = sign(null, readFileSync(a), secret());
  writeFileSync(`${a}.sig`, sig.toString("base64") + "\n");
  console.log(`signed ${a} -> ${a}.sig`);
} else if (cmd === "verify") {
  if (!a || !b) fail("verify needs the list and its signature");
  const ok = verify(null, readFileSync(a), publicFromCommitted(), Buffer.from(readFileSync(b, "utf8").trim(), "base64"));
  if (!ok) fail(`${b} is not the release key's signature over ${a}`);
  console.log(`${a} is signed by the release key`);
} else {
  fail("usage: release-sign.mjs keygen [file] | check | sign <list> | verify <list> <sig>");
}
