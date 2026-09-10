import type { MessageWithId } from './types.js';
import { sha256, assertMessagesRetained } from './storage.js';

type IncomingMessage = Omit<MessageWithId, 'id'>;

function key(msg: IncomingMessage): string {
  return JSON.stringify([new Date(msg.date).toISOString(), msg.author, msg.message, msg.attachment ?? null]);
}

/** Union by exact content/time and occurrence count, preserving every existing record. */
export function mergeMessages(existing: MessageWithId[], incoming: IncomingMessage[]): MessageWithId[] {
  const messages = [...existing];
  const existingCounts = new Map<string, number>();
  const incomingCounts = new Map<string, number>();
  const ids = new Set(existing.map(msg => msg.id));
  for (const msg of existing) {
    const identity = key(msg);
    existingCounts.set(identity, (existingCounts.get(identity) ?? 0) + 1);
  }
  for (const msg of incoming) {
    const identity = key(msg);
    const occurrence = (incomingCounts.get(identity) ?? 0) + 1;
    incomingCounts.set(identity, occurrence);
    if (occurrence <= (existingCounts.get(identity) ?? 0)) continue;
    let suffix = occurrence;
    let id = sha256(JSON.stringify([identity, suffix]));
    while (ids.has(id)) id = sha256(JSON.stringify([identity, ++suffix]));
    ids.add(id);
    messages.push({ id, ...msg });
  }
  messages.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  assertMessagesRetained(existing, messages);
  return messages;
}
