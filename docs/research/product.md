# Product reference: Grok Bot (desktop + mobile) and Hark

Date of research: 2026-11-07. Scope: research only, no code. Facts are sourced; inference and unverified items are marked.

## 1. Grok Bot

### Timeline (official)
- 2026-08-11: beta launch; desktop (macOS download) and iOS named; each Bot gets its own cloud computer per the launch page; no models named. Source: https://x.ai/news/introducing-grok-bot (fetched).
- 2026-08-26: "more plans" post; Bots have their own usage allotment; Grok Bot included with SuperGrok, Cursor Pro and Cursor Teams; no Android mention. Source: https://x.ai/news/grok-bot-more-plans (fetched).
- Undated: docs. Desktop: macOS (Apple silicon and Intel), Windows (x64, Arm64), Linux (x64, Arm64). Mobile: iPhone and Android. Source: https://cursor.com/docs/grok-bot (fetched, via summary).
- Mobile docs: iPhone iOS 18+, iPad iPadOS 18+, Android 9+. No app version or date. Source: https://docs.x.ai/grok-bot/mobile (fetched).

### Feature set (from docs, mainly the mobile and docs index pages)
- **Chat:** text, dictation, voice chat, voice memos, attachments, @mentions in group chats, threads, reactions, per-conversation drafts. Email and Slack drafts are edited, then sent or discarded (approval gate).
- **Navigation (mobile):** home with "+" (new Bot or group chat) and global search (messages, Bots, group chats, files, routines). Tap a Bot name for its profile (routines, notification settings, Library). Library = pages, images, videos, files, links grouped by date.
- **Settings (mobile):** account, plugins, Bot settings, time zone, cloud computer, device management, appearance, language, haptics, usage, feedback, sign-out/delete.
- **Bots:** multiple Bots, group chats, Bots hand work to each other. A "primary Bot" reports on the others (docs); the launch page calls it a "chief of staff" coordinating specialists. "Sub-agents" is not an official term.
- **Cloud computer:** persistent browser, filesystem, terminal. Mobile can watch the screen, take over for passwords, 2FA or CAPTCHA, then hand back. Updating and recovery need desktop.
- **Routines and skills:** a taught workflow is saved as a skill and rerun; a routine runs on a schedule in the background. Mobile: view schedules, next run, run history; pause/resume; swipe to delete; testing needs desktop.
- **Integrations:** Google Drive, Calendar, Gmail, Granola, Slack, Notion; any MCP server or API; "Browse all apps" marketplace. Prebuilt Bots named in docs: Overheard, Tradbot, Meeting Recap Deck, Pitch Deck Coach.
- **Phone features (mobile):** Calendar, Contacts, Location, Alarms (both OS); Reminders and Apple Home (iPhone). Only in a Bot the user owns, and Grok Bot must be open.
- **Notifications (mobile):** off per Bot or whole app. While the desktop app is open, Bot notifications go to desktop instead of phone. Docs say a Bot "comes back" when approval is needed.
- **Sign-in:** same Cursor account; SuperGrok or X Premium+ link via browser. In-app purchase = monthly individual only.

### Conflicts (report, do not resolve)
- **Cloud computer scope:** launch page (Aug 11) says "a cloud computer for each Bot." Docs say one computer per account, shared by all Bots (files, sessions, logins). Later docs win on specificity, but this is unconfirmed by a changelog.
- **Android:** launch page lists iOS and desktop only; later docs list Android. Treat Android as present per docs, dated later.
- **Desktop OS:** launch page names macOS; docs now list Windows and Linux. Likely later expansion; no dated changelog found.

### Pricing and plans
- Official plans page (per earlier watch notes, https://cursor.com/help/grok-bot/plans) lists plans with no dollar amounts. Prices quoted by third parties are unverified. Do not use them as facts.
- The help URL https://cursor.com/help/grok-bot returned 404 in this run.

### Not found
- No notification design detail beyond the mobile page. No trigger types beyond schedules and approvals. Opus 5.5 routing status is covered in the watch file (`D:\claude os\.work\grok-bot-watch\state.md`); still not confirmed live.

## 2. Hark (hark.com)

- **What it is:** a personal assistant app by Brett Adcock's startup Hark. Wide release 2026-10-06 (TechCrunch, https://techcrunch.com/2026/10/06/hark-releases-an-ai-personal-assistant-with-a-focus-on-privacy/, fetched). One aggregator dates it to Oct 7 (unverified, minor).
- **Platforms (hark.com, fetched):** iOS, Android, browser.
- **Proactive features (hark.com, fetched):**
  - Action Buttons: suggested tasks ranked from what you have to do; one click runs the task start to finish.
  - Handoff: a computer-use agent in its own secure browser (research, orders, building things).
  - Approval: checks in before anything that needs approval.
  - Panels: describe what you want; Hark builds a mini-app; can query connected services (Strava, Spotify, Venmo named).
  - Memory and Projects.
- **Triggers, schedules, monitoring, notification controls:** not described on hark.com (fetched) or TechCrunch. TechCrunch says the assistant "surfaces prompts" (expenses to approve, emails to answer, travel). Aggregator claims about email-driven buttons (Pay, Cancel, RSVP) are second-hand. Status: UNVERIFIED.
- **Pricing:** TechCrunch: free tier plus a paid tier for heavy users. Aggregators give $20 and $100 plans (unverified; sources disagree).
- **Conflict:** an aggregator says Handoff can run up to 36 browsers; a cited official doc says six. Not checked against the primary doc; unverified.
- **Name clash:** github.com/R44VC0RP/hark is an unrelated webhook-to-iPhone notification tool. Do not confuse them in the spec.

## 3. IP and trade-dress risk (copying the UI "identically" vs UX patterns)

Not legal advice. Secondary commentary plus primary statutes, US law only. Get counsel before shipping any near-clone.

- **Copyright does not protect ideas or methods.** 17 U.S.C. 102(b) excludes any idea, procedure, process, system, method of operation or concept. Source: https://www.law.cornell.edu/uscode/text/17/102 (fetched). Following UX patterns (chat list, Bot profile, routines tab) is low risk. Copying exact icons, layouts, copy text or assets is higher risk.
- **Trade dress (unregistered) needs nonfunctional design and secondary meaning.** Wal-Mart v. Samara Bros. (2000): product-design trade dress needs secondary meaning. Source: https://www.law.cornell.edu/supremecourt/text/529/205 (fetched summary; read the opinion for the exact test).
- **Interface functionality:** a 2015 Federal Circuit ruling in Apple v. Samsung treated home-screen icon and interface elements as functional, rejecting unregistered trade dress. Source: secondary commentary only, e.g., https://www.wilmerhale.com/en/insights/publications/protecting-a-companys-graphical-user-interface-may-6-2002 (2002 piece; not the 2015 opinion). UNVERIFIED for the 2015 holding detail; check the opinion before relying on it.
- **Names and marks:** do not use "Grok", "SpaceX", "xAI", "Cursor", "Hark" or "Bot" as product or feature names in a way that suggests affiliation. Feature names such as "Action Buttons", "Panels", "Routines", "Library" are UX terms; avoid copying them verbatim. Check the name with the name-availability process before branding.
- **Terms of service:** the Grok Bot and Hark terms were not reviewed here. Scraping or reusing their docs text in the product needs a separate check.

**Recommendation:** follow UX patterns (multi-Bot chat, approval gate, scheduled routines, per-Bot notification controls), write your own copy and icons, and do not reproduce layouts pixel-for-pixel.

## Recommendation for the spec
1. Build from the Grok Bot documented patterns: chat-first, multiple Bots, approval before outbound actions, saved routines with run history, shared-or-per-Bot computer as an explicit product decision.
2. Use Hark only as a reference for proactive "action suggestions" with approval; do not spec triggers from Hark (not documented).
3. Treat all pricing as unverified until a primary page shows it.

## Open items
- Confirm the cloud-computer scope with an official changelog or support answer.
- Confirm Android date from a store listing or official release note.
- Hark trigger/monitor model: needs a hands-on check (not doable from web sources).
- Trade-dress opinion check and counsel review.
