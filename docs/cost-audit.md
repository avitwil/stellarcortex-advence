# Cost audit (NFR-COST-01, C-04)

Every external host that shipped code, installers, images or CI talk to, and what it costs.
`scripts/check-cost.mjs` (run by `pnpm check:cost` in CI) fails when shipped code names a host
that is not in this table, or when a row is not free. Dependencies are covered by the license
audit (`pnpm check:licenses`, NFR-LIC-01): every bundled package is open source.

| Host | Used for | Cost |
|---|---|---|
| accounts.google.com | Google sign-in (OIDC) for users (D-03) | Free |
| oauth2.googleapis.com | Google token exchange | Free |
| www.googleapis.com | Google APIs: OIDC keys, Drive, Calendar | Free (Testing-mode project, DL-059) |
| gmail.googleapis.com | Gmail tools and the new-mail trigger | Free |
| people.googleapis.com | Contacts tool | Free |
| console.cloud.google.com | Links in the setup wizard to the owner's own Google project | Free |
| api.openai.com | Optional model source with the user's own key | Free to us; the user brings a key |
| api.github.com | Skill installs from GitHub (resolve the commit) | Free |
| codeload.github.com | Skill installs from GitHub (download at that commit) | Free |
| github.com | Links to the project and skill sources | Free |
| nodejs.org | Node.js runtime for the server installer | Free |
| podman.io | Link to Podman install docs when no package manager fits | Free |
| deb.debian.org | Chromium packages in the Bot computer image (DL-001) | Free |
| ftp-master.debian.org | Debian archive signing keys for that image layer | Free |
| opencode.ai | JSON schema URL inside the OpenCode config file (not fetched) | Free |
| updates.stellarcortex.invalid | Placeholder for the owner's self-hosted update feed (D-24) | Free (the owner's VPS) |
| updates.example.org | Example feed in code comments | Not contacted |
| example.com | Example addresses in placeholders | Not contacted |
| api.example.com | Example address in a placeholder | Not contacted |
| mcp.example.com | Example address in a placeholder | Not contacted |
| ntfy.example.net | Example push server in a placeholder | Not contacted |
| schemas.android.com | XML namespace in Android resources | Not contacted |
| www.w3.org | XML/SVG namespaces | Not contacted |
| www.apple.com | Property list DTD in the macOS service file | Not contacted |
| developer.android.com | Links in Android build comments | Not contacted |
| android.googlesource.com | Links in Android build comments | Not contacted |
| www.apache.org | License URL in the Gradle wrapper | Not contacted |
| www.gradle.org | Gradle wrapper | Free |

Not used anywhere: paid certificates (the server uses a self-signed certificate pinned by its
clients, DL-009), app store accounts (the APK and desktop installers are side-loaded), paid code
signing (Windows unsigned, macOS ad-hoc), Docker Desktop (Podman only), and paid CI (macOS and
Windows jobs run on demand within the free quota, DL-020).
