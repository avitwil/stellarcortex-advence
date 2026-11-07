// Engine registry (FR-CODE-01).
import type { Engine } from '@advence/protocol';
import { claudeEngine } from './claude.js';
import { codexEngine } from './codex.js';
import { opencodeEngine } from './opencode.js';
import type { CodingEngine } from './types.js';

export const ENGINES: Record<Engine, CodingEngine> = {
  'claude-agent-sdk': claudeEngine,
  codex: codexEngine,
  opencode: opencodeEngine,
};

/** npm packages installed into the Bot's home volume on first use (C-06: never bundled). */
export const ENGINE_PACKAGES: Record<Engine, string> = {
  'claude-agent-sdk': '@anthropic-ai/claude-agent-sdk',
  codex: '@openai/codex',
  opencode: 'opencode-ai',
};

export * from './types.js';
