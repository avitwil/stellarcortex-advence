# StellarCortex Advence: user guide

StellarCortex Advence is your own team of AI Bots, running on a server you control. Each Bot has
its own computer (a full desktop in a container), a memory that grows with use, and skills.
You talk to them from the desktop app or the Android app, in English or Hebrew.

**What is protected, plainly:** traffic is encrypted from your devices to your server; your
server runs the Bots and can read their content. Whoever controls the server can read what the
Bots see and do. Keep the server in trusted hands.

## Install the app

- **Windows**: run `stellarcortex-advence-<version>-win-x64.exe`. Windows SmartScreen warns
  because the app is not signed with a paid certificate: choose **More info → Run anyway**.
- **macOS**: open the `.dmg` and drag the app to Applications. The first time, macOS says it
  cannot check the developer: open **System Settings → Privacy & Security** and choose
  **Open Anyway** (the app is ad-hoc signed, not notarized).
- **Linux**: the `.AppImage` (make it executable and run it) or the `.deb`
  (`sudo apt install ./stellarcortex-advence-<version>-linux-*.deb`).
- **Android 9 or newer**: open the `.apk` from your server's update address on the phone and allow
  installing from that source when asked.

## Connect to your server

1. On the server, the owner runs `advence pair` (or uses **Settings → Devices → Add device** on a
   device that is already paired). It shows a QR code and a link.
2. In the app, choose **Scan QR code** (Android) or paste the link.
3. The app shows a 6-digit code. Type it where the QR code was shown. The app now trusts only
   that server's key; nobody in between can pose as it.
4. Sign in with Google. You can add more servers in **Settings → Servers** and switch between them.

## Bots and chats

- The sidebar lists your Bots and group chats. **+** creates a Bot or a group.
- Each Bot has a name, instructions, a model source (**Settings → Models and keys**: a local
  model server, your own API key, or the owner's Claude or ChatGPT subscription) and tools.
- Write to a Bot like in a messenger. Replies stream as they are written; **Stop** ends one.
  Attach files and images, react, reply in a thread, and @mention a Bot in a group to hand it the
  next turn. The primary Bot can hand tasks to other Bots.
- **Search** finds messages, Bots, groups and routines. **Library** collects links, images and
  files the Bots produced.

## The Bot's computer

Every Bot has its own desktop with a browser. Open it from the Bot's profile to watch it work.
**Take over** gives you the mouse and keyboard; the Bot waits until you hand it back. Coding
tasks run in a coding engine inside that computer and show their commands and changes in the
reply. Host control (a Bot using the server's own desktop) is off unless the owner turns it on
for that Bot.

## Memory and skills

Bots remember what matters (preferences, corrections, decisions) in a Markdown vault, encrypted
on the server by default. They also save skills, step-by-step know-how they can reuse. See and
manage both in **Settings → Memory** and **Settings → Skills**; you can install skills from
GitHub after reviewing them. The owner can switch the vault to plain files to open it in their
own Obsidian.

## Google and MCP

**Settings → Google connections** connects Gmail, Calendar, Drive and Contacts for your Bots.
Google's Testing mode ends the connection after 7 days; the app reminds you to reconnect.
**Settings → MCP servers** adds tools from MCP servers.

## Proactive Bots and routines

- A Bot marked **Proactive** in its profile acts on its own, including sending mail, with no
  approval prompt. Every action it takes is in **Activity** and in its profile.
- **Routines** start a Bot on a schedule, a new mail, a calendar event, a changed file, a webhook,
  an MCP notification or a daily digest. Each run answers in the Bot's chat.
- **Pause all** in the sidebar stops every autonomous run at once; each Bot also has its own
  **Paused** switch.
- A Bot that is not proactive never acts on outside content by itself: when a mail, a web page or
  a tool result could be steering it, any action that changes something waits for your **Allow**
  on an approval card that shows exactly what it will do.

## Notifications

Desktop apps show system notifications. On Android, notifications arrive through UnifiedPush
(install the ntfy app as the distributor once the owner has set up the push server). Turn them
off per Bot in its profile, or mute everything in **Settings → Notifications**.

## Updates

Apps update from your server's update address and check each update's signature first.
- Desktop: the update downloads in the background and installs when you quit (on macOS the
  verified installer opens for you to drag in).
- Android: **Settings → Updates → Check for updates**, then **Download and install**.
- The owner updates the server from **Settings → Updates**. If a new server version fails to
  start, it goes back to the previous one by itself.

## Settings at a glance

Account, Models and keys, Google connections, MCP servers, Skills, Memory, Bots, Cloud computer,
Devices (approve and revoke), Users (owner), Appearance (light, dark, system), Language (Hebrew,
English), Notifications, Usage (tokens and cost per Bot), Browser UI (owner), Updates, Servers.

