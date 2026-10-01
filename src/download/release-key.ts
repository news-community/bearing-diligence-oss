/**
 * The release key's public half: base64 of the 32 raw bytes of an Ed25519 key. Every release's
 * `checksums.txt` is signed by its private half, which exists only as the release workflow's
 * RELEASE_SIGNING_KEY secret. Written by `npm run release-key`; empty until then, and a build with
 * it empty refuses every update rather than installing one it cannot check.
 */
export const RELEASE_PUBLIC_KEY = "pNBAZCN4HbZB1hNqONysUvIOKMUyLZ5fa7DJX5GqMuY=";
