# Releasing

A release is a signed, notarised disk image for Apple silicon Macs, published on this repository's
Releases page with a signed checksum list. Pushing a version tag starts it; nothing else does.

## Cutting one

1. Set `version` in `package.json` to the new version.
2. In `CHANGELOG.md`, date that version's section: `## 0.2.0, 2026-10-15`. The section is the release
   notes; a section still marked `unreleased`, or none at all, stops the release in its first minute.
3. Commit, then tag that commit and push the tag:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

   A tag with a suffix (`v0.2.0-rc.1`) publishes a pre-release, which the app's update check ignores.

The workflow is `.github/workflows/release.yml`. It takes 20 to 60 minutes, most of it Apple's
notarisation.

## What it checks, and why

| Step | Why it is there |
|---|---|
| Every secret is present, the tag matches `package.json`, the notes exist and are dated, and the release key matches the one compiled into the app | A missing piece otherwise fails twenty minutes in, or not at all: a release with no notes, or one signed by a key no installed copy trusts, looks normal |
| The signature is read back from the built app: a Developer ID, the hardened runtime, an Apple team | A signing step can do nothing and report success; that once shipped an unsigned release of another app |
| Gatekeeper is asked about the disk image and about a copy of the app marked as downloaded; the app is then run with the mark cleared and must report the tagged version and stay running | That is what a person's Mac does. Launching a quarantined app on a runner waits on a dialog nobody can click |
| The release is a draft until every file has been downloaded again and checked against the signed checksum list | A release once went public missing a file |

## How an installed copy updates

The app's **Check for updates** asks GitHub for the latest release and sends nothing about the person.
**Install** is offered only on a signed copy outside its disk image, in a folder the account can
write. It downloads the release, verifies `checksums.txt.sig` against the public key in
`src/download/release-key.ts`, checks the disk image against the list, requires the new app to pass
`codesign --verify --strict`, to carry the same Apple team as the running app and to be accepted by
Gatekeeper, runs it with `--version-probe` to confirm its version is the release's and is newer, and
then swaps the bundle, putting the old one back if that fails. It relaunches only when the person
presses Restart. See `src/download/install.ts`.

## Secrets

Set on this repository (Settings, Secrets and variables, Actions):

| Secret | What it is |
|---|---|
| `MACOS_CERT_P12` | The Developer ID Application certificate and its private key, exported as a .p12 and base64-encoded (`base64 -i cert.p12`) |
| `MACOS_CERT_PASSWORD` | The .p12's password |
| `NOTARY_KEY_P8` | An App Store Connect API key for notarisation: the .p8 file's contents |
| `NOTARY_KEY_ID` | That key's id |
| `NOTARY_ISSUER_ID` | That key's issuer id |
| `RELEASE_SIGNING_KEY` | The Ed25519 private key whose public half is in `src/download/release-key.ts` |

The release key is made once, with `node scripts/release-sign.mjs keygen`, which writes the private
half outside the repository and the public half into the source. **Losing the private half** means
the next release is signed by a new key that no installed copy trusts, so each person downloads that
one release by hand. Keep an offline backup.

## Building one locally

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist
```

makes an unsigned disk image in `release/`, which opens on the machine that built it and nowhere
else. It cannot install updates, because it has no Apple team to compare a new copy with.
