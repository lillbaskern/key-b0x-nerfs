# Releasing

This document is maintainer-facing. It covers the current GitHub Actions
release flow and the manual checks required before publishing a public build.

## Workflows

The repo uses three GitHub Actions workflows:

- `ci.yml`: fast validation on pull requests and pushes to `main`
- `bundle-smoke.yml`: real AppImage and NSIS packaging on `main` and manual
  runs, uploaded as workflow artifacts
- `release.yml`: tag-driven draft GitHub Releases with AppImage, NSIS,
  updater signatures, `latest.json`, and `SHA256SUMS.txt`

## Release Steps

1. Bump the desktop app version in `apps/desktop/package.json`.
2. Merge the release candidate to `main`.
3. Let `bundle-smoke.yml` build the real installers from `main`.
4. Manually validate the Linux AppImage and Windows NSIS installer before any
   public release.
5. Verify the updater signing secret is present in GitHub Actions:
   `TAURI_SIGNING_PRIVATE_KEY` (content of the updater key — see
   *Updater signing* below; `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is only
   needed if the key has a password).
6. Create a `vX.Y.Z` tag.
7. Let `release.yml` build the same packaging matrix and create a draft GitHub
   Release.
8. Validate the draft release artifacts, updater signatures, `latest.json`,
   and checksums, then publish it.

## Windows code signing (SignPath)

Windows builds are Authenticode-signed through [SignPath](https://signpath.io).
The certificate is issued to *SignPath Foundation* and stays on SignPath's
servers; `bundle.windows.signCommand` in `tauri.conf.json` points each build
at `src-tauri/scripts/signpath-sign.ps1`, which uploads the bundled installer
to the SignPath API and writes the signed file back in place.

### One-time setup

1. Publish this repository as a **public GitHub repo** (OSI license required).
2. Apply for the free Open Source subscription at https://signpath.org
   (approval is not automatic).
3. In SignPath: create a project + signing policy and a CI API token.
4. Add the token as a GitHub Actions secret:
   - `SIGNPATH_API_TOKEN`
   - `SIGNPATH_ORGANIZATION_ID`
   - `SIGNPATH_PROJECT_SLUG`
   - `SIGNPATH_SIGNING_POLICY_SLUG`
   - optionally `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`
5. Mention the code signing policy on the download page, e.g. "Free code
   signing provided by [SignPath.io](https://about.signpath.io), certificate
   by [SignPath Foundation](https://signpath.org)" (required by their terms).

The script auto-fills origin verification (repository URL, branch, commit,
CI run URL) from the standard GitHub Actions environment variables, which
SignPath Foundation subscriptions require. Every OSS signing request needs
manual approval in the SignPath web UI before it completes.

### Local builds

Local `tauri build` runs the same script. Without `SIGNPATH_API_TOKEN` set it
leaves the installer **unsigned** with a warning and the build succeeds — so
day-to-day development is unaffected. To sign locally you need SignPath
credentials with submitter rights; note that Foundation OSS subscriptions
verify build origin and may only accept requests from CI.

### Modified-fork caveat

SignPath Foundation's terms only allow signing a modified version of upstream
software when the repo is a **visible GitHub fork** of an upstream project
that publishes signed builds, with releases based on upstream branches. If
that cannot be satisfied, the application will not be approved for signing.

## Updater signing (fork-owned)

In-app updates are owned entirely by this repository:

- `bundle.createUpdaterArtifacts` is `true`, so builds emit a minisign
  `.sig` next to each installer — `release.yml` and `bundle-smoke.yml` both
  assert that exactly one exists per platform.
- `plugins.updater.endpoints` points at this repo's
  `releases/latest/download/latest.json`, and `plugins.updater.pubkey` holds
  this fork's public key. `release.yml` embeds each installer's signature in
  the generated `latest.json`.
- The private key lives at `~\.tauri\key-b0x-nerfs.key` (with `.key.pub`).
  **Never commit either file.** Paste the `.key` file's content into the
  `TAURI_SIGNING_PRIVATE_KEY` Actions secret — the bundler ignores
  `TAURI_SIGNING_PRIVATE_KEY_PATH`, the value must be the key itself. The
  key has no password, so `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` can stay
  unset.
- Signing order and SignPath coexist safely: Tauri runs the Authenticode
  `signCommand` on the finished installer first, then generates the `.sig`
  over those signed bytes, so both signatures verify on the final file.
- Rotating the updater key breaks in-app updates for every previously
  shipped build (they verify against the pubkey baked in at their build
  time) and would require another manual bridge release. Only rotate if
  the key is lost or compromised.

## Notes

- Public release remains gated on manual installer verification on both Linux
  and Windows.
- Reserve the protected GitHub `release` environment for Windows signing
  secrets before the first public release.
- Linux AppImage releases target modern Linux distributions rather than
  oldest-possible glibc compatibility.
- In-app updates require one manual bridge release first: builds up to 0.1.1
  embedded upstream's updater endpoint and public key, so they cannot verify
  fork-signed updates. Install the first fork-owned release manually once;
  every release after that can be delivered in-app.
- GitHub Actions must be enabled for the repository (Settings → Actions)
  before any workflow can run.
- For Linux in-app updates, keep the AppImage in a stable writable location
  such as `~/Applications/key-b0x.AppImage`.
