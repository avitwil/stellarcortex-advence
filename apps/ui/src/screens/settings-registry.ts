// Settings sections contributed by later phases.
import type { ComponentType } from 'react';
import type { SectionId } from './Settings';
import { BotsSection, ModelsSection, NotificationsSection, UsageSection } from './chat/ChatSettings';

export const extraSections: Partial<Record<SectionId, ComponentType>> = {
  models: ModelsSection,
  bots: BotsSection,
  notifications: NotificationsSection,
  usage: UsageSection,
};
