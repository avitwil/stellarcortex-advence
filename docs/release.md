# Releasing StellarCortex Advence

This is the owner's checklist for a release (D-24, NFR-SEC-10, C-07). Nothing is published by
CI. A release candidate is a private workflow artifact until you approve it and upload it to your
own update server yourself.

## 1. Once: create the release key

Run this on your own computer, not on the server and not in the repository folder:

```sh
node scripts/release/keygen.mjs --out ~/advence-release.key
```

It writes the private key with owner-only permissions and prints the public key. The script
refuses to write inside the repository or over an existing key.

- Keep `~/advence-release.key` offline and backed up (for example on two USB drives). Whoever
  holds it can ship updates to every install. If it is lost, installs can only move to a new key
  through a reinstall.
- In GitHub, under the repository's **Settings → Secrets and variables → Actions**:
  - add the **variable** `ADVENCE_RELEASE_PUBKEY` with the printed public key;
  - add the **variable** `ADVENCE_FEED_URL` with your feed address, for example
    `https://updates.example.org` (your VPS, https only);
  - optionally let CI sign candidates. Under **Settings → Environments**, create the environment
    `release`, add yourself as a **required reviewer**, limit **deployment branches** to the branch you release from (normally `main`),
    and add the **environment secret** `ADVENCE_RELEASE_KEY` with the file's content. Do not add
    it as a repository secret: any workflow on any branch could read that. Without it, CI builds
    unsigned candidates and you sign on your own computer (step 3), which keeps the key off GitHub
    entirely and is the safer choice.
- For a signed APK, add the secrets `ADVENCE_ANDROID_KEYSTORE_B64` (the keystore, base64),
  `ADVENCE_ANDROID_KEYSTORE_PASSWORD`, `ADVENCE_ANDROID_KEY_ALIAS` and
  `ADVENCE_ANDROID_KEY_PASSWORD`. Keep the same keystore forever: Android only installs an update
  signed with the same certificate. Create one with
  `keytool -genkeypair -v -keystore advence.jks -keyalg RSA -keysize 4096 -validity 10000 -alias advence`.
  Its SHA-1 (`keytool -list -v -keystore advence.jks`) is what the setup wizard shows for the
  Android OAuth client; set it as the variable `ADVENCE_ANDROID_SHA1`.

Every build pins the public key. The server, the desktop apps and the Android app refuse any
update whose manifest is not signed by it, and any file whose SHA-256 or size differs from the
manifest.

## 2. Build a release candidate

In GitHub, **Actions → release-candidate → Run workflow**, with:

- `version`: for example `1.0.0` or `1.0.0-rc.1`;
- `version_code`: a whole number larger than the previous Android release;
- `notes`: what changed (shown in the apps before installing).

It builds the server bundles (Linux x64, macOS Apple silicon and Intel, Windows x64), the
desktop installers, the APKs, the manifests and the two installers, signs and verifies them when
the secret exists, and keeps a `feed-<version>` artifact for 30 days. macOS and Windows runner
minutes count more against the free quota (DL-020), so run it only for real candidates. When the `release`
environment has you as a required reviewer, its last job (manifests and signing) waits for your
approval.

## 3. Check and sign on your computer

Download `feed-<version>` and unpack it. If it contains `UNSIGNED.txt`, sign it:

```sh
for c in server desktop android; do
  node scripts/release/sign.mjs --key-file ~/advence-release.key --expect "$ADVENCE_RELEASE_PUBKEY" feed/$c/manifest.json
done
```

Then verify everything against the public key, as an install would:

```sh
for c in server desktop android; do
  node scripts/release/verify.mjs --pub "$ADVENCE_RELEASE_PUBKEY" feed/$c/manifest.json --dir feed/$c
done
```

Every line must say `ok` and each manifest `signature ok`. Delete `UNSIGNED.txt`.

Test the candidate before you publish it (`docs/manual-checks.md`, section P7): install it on a
spare machine with the one-line installer pointed at a local copy of the feed, update a running
install to it, and install the APK on a phone.

## 4. Publish (your approval)

Publishing is your step only (C-07). Upload the folder to your web server so that it is served
as:

```
https://updates.example.org/install.sh
https://updates.example.org/install.ps1
https://updates.example.org/server/manifest.json (+ .sig and the bundles)
https://updates.example.org/desktop/manifest.json (+ .sig, installers, latest*.yml)
https://updates.example.org/android/manifest.json (+ .sig and the APKs)
```

Any static web server works (nginx, Caddy). Upload the files first and the manifests and their
`.sig` files last, so nobody sees a manifest for files that are not there yet.

Installs pick the release up by themselves: servers check daily and the owner installs from
**Settings → Updates** (or `advence update apply`), desktop apps download and verify it, and the
Android app offers it in **Settings → Updates**.

## Rotating the key

Builds accept several pinned keys (comma separated in `ADVENCE_RELEASE_PUBKEY`). To rotate: add
the new public key next to the old one, release a version signed with the old key, then sign
later releases with the new key and drop the old one from the variable.
