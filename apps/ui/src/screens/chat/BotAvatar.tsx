import type { Bot } from '@advence/protocol';

/** A Bot's avatar: its emoji or letters on our gradient. */
export function BotAvatar({ bot, size }: { bot: Pick<Bot, 'avatar' | 'name'>; size?: 'lg' }) {
  return <span className={`avatar ${size ?? ''}`} aria-hidden="true">{bot.avatar || bot.name.slice(0, 1).toUpperCase()}</span>;
}
