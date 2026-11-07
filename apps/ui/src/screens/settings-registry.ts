// Later phases register their settings sections here.
import type { ComponentType } from 'react';
import type { SectionId } from './Settings';

export const extraSections: Partial<Record<SectionId, ComponentType>> = {};
