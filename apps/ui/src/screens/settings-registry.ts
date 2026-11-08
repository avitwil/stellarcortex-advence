// Settings sections contributed by later phases (P2: models, Bots, notifications, usage; P3: cloud computer; P4: skills, memory; P5: Google, MCP).
import type { ComponentType } from 'react';
import type { SectionId } from './Settings';
import { BotsSection, ModelsSection, NotificationsSection, UsageSection } from './chat/ChatSettings';
import { ComputerSection } from './chat/ComputerSettings';
import { MemorySection, SkillsSection } from './chat/MemorySettings';
import { GoogleSection, McpSection } from './chat/IntegrationSettings';
import { BrowserUiSection, UpdatesSection } from './UpdateSettings';

export const extraSections: Partial<Record<SectionId, ComponentType>> = {
  models: ModelsSection,
  bots: BotsSection,
  notifications: NotificationsSection,
  usage: UsageSection,
  computer: ComputerSection,
  skills: SkillsSection,
  memory: MemorySection,
  google: GoogleSection,
  mcp: McpSection,
  updates: UpdatesSection,
  browserUi: BrowserUiSection,
};
