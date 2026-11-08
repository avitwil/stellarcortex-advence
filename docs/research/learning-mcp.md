# stellarcortex-advence - research brief: learning loop, Obsidian memory, MCP, third-party skills

Date of research: 2026-11-07. Scope: research only, no code. Topic C items 1-5.
Legend: [F] = fact, sourced from a primary page fetched today. [S] = secondary/search summary, not verified against the primary. [I] = my inference. [NF] = not found.

## 1. Self-learning with a curator (Hermes style)

Facts
- [F] Hermes curator is a background maintenance pass for agent-created skills only. Defaults: `interval_hours` 168 (7 days), `min_idle_hours` 2. Not a cron job; checked on CLI start, gateway housekeeping, or the `hermes serve` timer. First install does not run immediately. Source: https://hermes-agent.nousresearch.com/docs/user-guide/features/curator
- [F] Deterministic transitions (on when enabled): unused 14 days -> stale; unused 30 days -> archived to `~/.hermes/skills/.archive/`. Never auto-deletes. The same page's adoption section says 30/90 days; the page does not reconcile this. Treat thresholds as configurable, not fixed.
- [F] LLM consolidation pass is OFF by default (`curator.consolidate: true` or `--consolidate`). Takes a tar.gz snapshot first; `rollback` restores; a per-mutation JSONL ledger supports single-entry rollback. `--dry-run` previews.
- [F] Protections: pinned skills, locked skills (agent cannot write), skills referenced by cron, hub-installed skills, bundled skills (unless `prune_builtins`).
- [F] Telemetry in `.usage.json`: view_count, use_count, patch_count, timestamps, state. Only `created_by: agent` skills are curated; skills made via `/learn` are not.
- [F] Prior analysis (`D:\claude os\.work\hermes-self-improve\analysis.md`, from source at 2026-10-12): review fork every 10 user turns / 10 tool iterations, post-turn, max 16 iterations, write tools only, patch-before-create, "Never delete a skill here", atomic batches with per-skill lock. Source: the repo, not re-verified today.
- [F] Hermes README: MIT license, self-described "self-improving AI agent"; no curator text in README. Source: https://github.com/NousResearch/hermes-agent
- [S] Release v2026.4.30 (v0.12.0) reportedly added `hermes curator status`; release page itself not fetched.

Our repo pattern (D:\claude os\.claude\brain\LEARN.md, brain-curator in brain-guard plugin)
- [F] LEARN.md: signals (user correction, forwarded review/QA findings, reusable technique, wrong skill), order (patch loaded skill > patch existing > update memory > create), do-not-capture list, never delete. Prior design (`design.md`) recommended: deterministic write guard, Learn stage via SendMessage, weekly curator proposal, archive-not-delete.

Inference
- [I] Our design already matches Hermes on the important parts (patch-first, no delete, do-not-capture). Missing: usage telemetry for brains (counts of loads/patches) and a deterministic write guard. The LLM consolidation pass should stay off by default.

## 2. Creating skills and learning workflows

Facts
- [F] Agent Skills spec (open standard): a skill is a folder with `SKILL.md` (YAML frontmatter + Markdown). Frontmatter: `name` 1-64 chars, lowercase a-z0-9 and hyphens, no leading/trailing or double hyphen, must equal directory name; `description` 1-1024 chars; optional `license`, `compatibility` (<=500), `metadata` (string map), `allowed-tools` (experimental). Optional `scripts/`, `references/`, `assets/`. Progressive disclosure: name+description at startup, body on activation (<5000 tokens recommended, <500 lines), resources on demand. Validator: `skills-ref validate`. Source: https://agentskills.io/specification
- [F] Claude Code follows the open standard and adds fields (`paths`, `context: fork`, `disable-model-invocation`, `hooks`, `model`, etc.). Outside Claude Code, only the standard fields are accepted; other fields cause a hard validation error. Locations: project `.claude/skills/`, personal `~/.claude/skills/`, plugin `<plugin>/skills/`. Source: https://code.claude.com/docs/en/skills
- [F] Hermes auto-creation: `skill_manage` create/patch/write_file/remove_file/delete, fuzzy patch, atomic batches; validation: name regex, description <=1024 (<=60 for new skill in code), content <=100k chars. Source: prior analysis (repo).
- [NF] Procedural-memory academic benchmarks and "auto skill generation" quality numbers were not found in primary sources.

Inference
- [I] Use the Agent Skills format for any skill the team writes, so one file works in Claude Code, Hermes and other clients. Keep Claude-only fields out of portable skills.

## 3. Long-term memory on Obsidian for all agents

Facts
- [F] Obsidian license page (last updated 2026-02-20 per page footer; search said Feb 20, 2025): free for commercial use, including for-profit organizations. Source: https://obsidian.md/license
- [F] Obsidian Terms: no sublicensing, sale, distribution or sharing of the Software or Services; no derivative works; no providing "a service for others"; Software license covers installing on machines you operate. Terms do not say whether embedding in a product is allowed. Source: https://obsidian.md/terms
- [F] Obsidian Local REST API plugin: MIT. Bearer API key; HTTPS on 127.0.0.1:27124 (self-signed CA), optional plain HTTP 27123; endpoints for /vault/{path} GET/PUT/PATCH/POST/DELETE, /search/simple/, /search/ (JsonLogic), /commands/, /active/, /events/ (SSE), /mcp/ (Streamable HTTP). README security notes: `.obsidian` config dir blocked by default (writing = RCE risk); 10 bad keys/min -> 429; signed URLs valid until expiry; large base64 responses can crash the renderer. Source: https://github.com/coddingtonbear/obsidian-local-rest-api
- [NF] Obsidian Sync conflict behavior and encryption/pricing: the help page redirect (help.obsidian.md -> obsidian.md/help/sync/conflicts) did not contain the content. Not verified.
- [NF] Embeddings/retrieval plugin licenses, not researched in depth (Smart Connections etc.). Not verified.

Inference
- [I] Do not ship or bundle Obsidian in the product. The Terms restrict redistribution and "service for others", so bundling is a legal risk; a counsel check is needed before any commercial distribution. Instead, make the memory a plain Markdown folder (frontmatter + wikilinks) that Obsidian can open, read/written by our own code.
- [I] Layout: one folder per agent for private notes plus one `shared/` folder for facts all agents need; ownership rule: each agent writes only its own folder (same rule as the current brains). Retrieval: start with keyword/FTS over the files and frontmatter index; add embeddings only if the note count justifies it.
- [I] Concurrency: a single writer per file (lock file or the owner-agent rule), append-only logs for shared notes, and git as the history/merge tool. Avoid running the Local REST API on a shared server; it is a single-user localhost tool with a single API key.

## 4. Full MCP support

Facts
- [F] Latest spec revision on the official site: 2026-07-28 (changelog page). Previous: 2025-11-25. Source: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- [F] Breaking changes in 2026-07-28: protocol sessions and `Mcp-Session-Id` removed; the `initialize` handshake removed; every request carries protocol version and capabilities in `_meta`; `server/discover` MUST be implemented by servers; SSE resumability removed (broken streams must be re-issued); `ping`, `logging/setLevel` and `notifications/roots/list_changed` removed; tasks moved to the extension `io.modelcontextprotocol/tasks` (polling via `tasks/get`, `tasks/update`); MRTR (`resultType: "input_required"`) replaces server-initiated `roots/list`, `sampling/createMessage`, `elicitation/create`.
- [F] Deprecated in 2026-07-28 (still functional): Roots, Sampling, Logging; HTTP+SSE transport; DCR (RFC 7591) in favour of Client ID Metadata Documents. Source: same changelog.
- [F] Elicitation (Active): form mode (flat JSON-schema primitives) and URL mode (out-of-band). Servers MUST NOT request passwords/API keys/tokens via form mode; MUST use URL mode. URL mode: client must show full URL and get consent, must not prefetch, server must verify the user who opens the URL (phishing). Source: https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- [F] Authorization (HTTP transports only; STDIO takes credentials from env): OAuth 2.1 draft, RFC 9728 (servers MUST), RFC 8707 resource indicators (clients MUST), RFC 9207 `iss` check, RFC 8414 or OIDC discovery, Client ID Metadata Documents (SHOULD); tokens MUST NOT be in query strings and MUST NOT be passed through to other servers (no token passthrough). Source: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- [F] MCP Registry: in preview, may reset data before GA; hosts metadata (server.json), not code; namespace verification via GitHub/DNS; does not list private servers; manual takedown. Source: https://modelcontextprotocol.io/registry/about
- [S] Sampling and roots are in the spec but deprecated; resources and prompts were not called out as changed in the changelog (not fully read).
- [S] 2026 CVEs in MCP servers (e.g., CVE-2026-27825 mcp-atlassian, CVE-2026-5058 aws-mcp-server) reported by secondary blogs; IDs not checked against NVD. Tool poisoning class: Invariant Labs advisory (Apr 2025).

Inference
- [I] Target 2026-07-28 for new servers, but support 2025-11-25 for clients that have not updated, because version negotiation on the new spec is a clean break. Use Streamable HTTP for remote, stdio for local. Do not build new features on Sampling/Roots/Logging. Use URL-mode elicitation for any secret (bot tokens, exchange keys).

## 5. Third-party skills: skills.sh / agentskills.io, install, verify, sandbox

Facts
- [F] skills.sh: installed with the `skills` CLI from GitHub `owner/repo`; CLI open source (github.com/vercel-labs/skills). Leaderboard from anonymous CLI telemetry. Page mentions "routine security audits" without describing them; no code signing or publisher verification mentioned; Vercel says it cannot guarantee the quality or security of any skill. Source: https://skills.sh/docs
- [S] Snyk ToxicSkills (Feb 2026): scanned 3,984 skills, 534 with at least one critical issue, 76 confirmed malicious; 8 still live on ClawHub at publication. Source: https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub
- [S] CSA research note (June 2026) reports 1,184+ malicious skills on ClawHub distributing a macOS stealer (Feb-May 2026); the delivery vector is the skill-install pathway, not an OpenClaw bug. Source: CSA PDF (not read in full): https://labs.cloudsecurityalliance.org/wp-content/uploads/2026/06/CSA_research_note_ai-skill-supply-chain-attacks_20260624-csa-styled.pdf
- [F] Agent Skills `allowed-tools` is experimental; the standard allows scripts in `scripts/`, which is the main execution risk. Source: https://agentskills.io/specification

Inference
- [I] Risks: a skill is instructions plus scripts that run with the agent's permissions; registries have no signing; search ranking is gameable (academic result cited in search summary, unverified). Required controls before any third-party skill is installed: pin to a commit SHA, read the full SKILL.md and scripts, scan (static + injection patterns), no install from the agent's own initiative, run in a sandbox/container without secrets, user approval (per the user's standing rule: install only after OK).

## Options (summary)

| Topic | Option | Pros | Cons | Fit |
|---|---|---|---|---|
| Learning | A. Prompt-only (Hermes ported text) | Cheap | Not enforced | Baseline |
| Learning | B. Learn pass + write guard + curator (archive only) | Reliable, auditable, git ledger | Build work for guard and usage counts | Recommended |
| Learning | C. Headless background fork after each task | Closest to Hermes, unattended | Extra tokens per review, races, harder to observe | Later |
| Memory | Obsidian app plugin / bundled app | Good UI | Terms block bundling; app must run | Avoid bundling |
| Memory | Plain Markdown vault, Obsidian-compatible, own access layer | Portable, no license issue | We write the search layer | Recommended |
| MCP | 2026-07-28 only | Newest features | Clients may lag | Not alone |
| MCP | 2026-07-28 + 2025-11-25 fallback | Interop | Two code paths | Recommended |
| Skills | Install from skills.sh | Large catalog | No signing, no verified audit | Only with the controls above |
| Skills | Write own, Agent Skills format | Full control | Maintenance | Default |

## Recommendation

1. Learning: adopt option B. Keep the LEARN.md rules, add usage counts per skill, a deterministic write guard, and a curator that proposes archive moves only. LLM consolidation stays off.
2. Memory: plain Markdown vault in git, per-agent folders plus `shared/`, owner-writes-only; keyword search first. No Obsidian bundling. Get a counsel opinion before any commercial release.
3. MCP: support 2026-07-28 and 2025-11-25; Streamable HTTP for remote; OAuth 2.1 with RFC 9728/8707; URL-mode elicitation for secrets; no Sampling/Roots.
4. Skills: Agent Skills format; third-party skills only after the control list in section 5.

## Open items (not verified)
- Obsidian Sync conflict and encryption details.
- Hermes curator threshold conflict (14/30 vs 30/90 days).
- Exact CVE IDs and CVSS (NVD check needed).
- Hermes release date for the curator (v2026.4.30 claim).
- Embedding plugin licenses.
