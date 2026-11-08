// P2 unit tests: mentions, Library extraction, search query sanitizing, CLI transcript.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mentionedBots } from './chat/runtime.js';
import { extractLinks, kindForUrl } from './chat/library.js';
import { ftsQuery } from './chat/search.js';
import { transcript } from './models/cli.js';
import { BOT_IMAGE, PodmanHost } from './models/host.js';
import { fakeTool, shPath } from './test-utils/posix.js';

describe('FR-BOT-03 @mentions', () => {
  const bots = [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Ann Lee' }, { id: 'c', name: 'מתכנן' }];
  it('matches whole names, longest first, case-insensitive, Hebrew too', () => {
    expect(mentionedBots('hi @ann lee and @ANN', bots)).toEqual(['b', 'a']);
    expect(mentionedBots('@Annie is not Ann', bots)).toEqual([]);
    expect(mentionedBots('שלום @מתכנן, תתחיל', bots)).toEqual(['c']);
    expect(mentionedBots('email ann@example.com', bots)).toEqual([]);
  });
});

describe('FR-UI-04 Library extraction', () => {
  it('finds markdown links, images and bare URLs once each', () => {
    const l = extractLinks('[Doc](https://x.test/a.pdf) ![img](https://x.test/b.png) https://x.test/c, and https://x.test/a.pdf.');
    expect(l).toEqual([
      { url: 'https://x.test/a.pdf', title: 'Doc' },
      { url: 'https://x.test/b.png', title: 'img' },
      { url: 'https://x.test/c', title: 'https://x.test/c' },
    ]);
    expect(extractLinks('javascript:alert(1) [x](javascript:alert(1))')).toEqual([]);
    expect(kindForUrl('https://x.test/v.mp4?x=1')).toBe('video');
  });
});

describe('FR-UI-01 search query', () => {
  it('quotes every word so FTS operators cannot be injected', () => {
    expect(ftsQuery('hello "world" OR NEAR(x')).toBe('"hello"* "world"* "OR"* "NEAR(x"*');
    expect(ftsQuery('   ')).toBe('');
  });
});

describe('D-07c subscription CLIs', () => {
  it('render the conversation as one prompt', () => {
    expect(transcript([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).toBe('hi');
    expect(transcript([
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', text: 'b' },
      { role: 'user', content: [{ type: 'text', text: 'c' }] },
    ])).toContain('User: a\n\nAssistant: b\n\nUser: c');
  });

  it('run in the Bot container with secrets passed by name only (NFR-SEC-09)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advence-podman-'));
    const fake = fakeTool(dir, 'podman', `printf '%s\\n' "$@" > "${shPath(dir)}/argv"\nprintf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" > "${shPath(dir)}/env"\n`);
    const run = new PodmanHost({ podman: fake.bin, podmanArgs: fake.args }).run({ botId: 'bot_x', argv: ['claude', '-p'], stdin: '', env: { CLAUDE_CODE_OAUTH_TOKEN: 'secret-value', 'bad name': 'x' }, signal: new AbortController().signal });
    expect((await run.done).code).toBe(0);
    const argv = fs.readFileSync(path.join(dir, 'argv'), 'utf8').trim().split('\n');
    expect(argv.join(' ')).not.toContain('secret-value');
    expect(argv).toEqual(expect.arrayContaining(['--rm', '--cap-drop', 'all', 'no-new-privileges', '-e', 'CLAUDE_CODE_OAUTH_TOKEN', 'advence-bot-bot_x-home:/home/bot', BOT_IMAGE, 'claude', '-p']));
    expect(argv).not.toContain('bad name');
    expect(fs.readFileSync(path.join(dir, 'env'), 'utf8')).toBe('secret-value');
  });
});

describe('FR-UI-01 conversation previews', () => {
  it('are one line of plain text', async () => {
    const { previewOf } = await import('./chat/store.js');
    expect(previewOf('Here is **bold** and a list:\n\n- one\n- two\n\nSee [docs](https://x.test/a.pdf).')).toBe('Here is bold and a list: one two See docs.');
  });
});
