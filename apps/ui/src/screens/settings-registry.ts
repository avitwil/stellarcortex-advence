// Settings sections contributed by later phases (P2: models, Bots, notifications, usage; P3: cloud computer).
import type { ComponentType } from 'react';
import type { SectionId } from './Settings';
import { BotsSection, ModelsSection, NotificationsSection, UsageSection } from './chat/ChatSettings';
import { ComputerSection } from './chat/ComputerSettings';

export const extraSections: Partial<Record<SectionId, ComponentType>> = {
  models: ModelsSection,
  bots: BotsSection,
  notifications: NotificationsSection,
  usage: UsageSection,
  computer: ComputerSection,
};
