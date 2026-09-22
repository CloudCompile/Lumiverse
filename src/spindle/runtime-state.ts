import * as chats from '../services/chats.service';
import * as characters from '../services/characters.service';
import * as personas from '../services/personas.service';
import * as settings from '../services/settings.service';
import * as books from '../services/world-books.service';
import { getCharacterWorldBookIds } from '../utils/character-world-books';
import { runtimeStateRevision } from './runtime-state-revision';
import type { Character } from '../types/character';
import type { Message } from '../types/message';

export type RuntimeStateCommand =
  | { kind: 'chat.metadata'; key: string; value: unknown }
  | { kind: 'chat.variables'; values: Record<string, string | null> }
  | { kind: 'message.edit'; id: string; content: string }
  | { kind: 'message.delete'; id: string }
  | { kind: 'message.create'; id: string; content: string; role: string }
  | { kind: 'character.update'; id: string; patch: { name?: string; description?: string; first_mes?: string } }
  | { kind: 'persona.update'; id: string; patch: { name?: string; description?: string } }
  | { kind: 'lore.create'; bookId: string; patch: Record<string, unknown> }
  | { kind: 'lore.update'; id: string; patch: Record<string, unknown> }
  | { kind: 'lore.delete'; id: string };

export function projectRuntimeCharacter(character: Character) {
  const { extensions: _extensions, ...fields } = character;
  return { ...fields, world_book_ids: getCharacterWorldBookIds(character.extensions) };
}

export function projectRuntimeMessage(message: Message) {
  const role: 'user' | 'system' | 'assistant' = message.is_user ? 'user' : message.extra?.spindle_role === 'system' ? 'system' : 'assistant';
  return { id: message.id, content: message.content, role, name: message.name,
    index_in_chat: message.index_in_chat, created_at: message.created_at, send_date: message.send_date,
    extra: { greeting_index: message.extra?.greeting_index } };
}

export function readRuntimeState(userId: string, chatId: string, characterId: string) {
  const chat = chats.getChat(userId, chatId);
  const character = characters.getCharacter(userId, characterId);
  if (!chat || !character) throw new Error('Runtime chat or character not found');
  const activePersonaId = settings.getSetting(userId, 'activePersonaId')?.value;
  const persona = typeof activePersonaId === 'string' ? personas.getPersona(userId, activePersonaId) : null;
  const worldBookIds = getCharacterWorldBookIds(character.extensions);
  // All reads are synchronous, so the revision describes this complete state without an interleaving write.
  return { revision: runtimeStateRevision(userId), chat, character: projectRuntimeCharacter(character), persona,
    messages: chats.getMessages(userId, chatId).map(projectRuntimeMessage),
    lore: worldBookIds.flatMap(id => books.listEntries(userId, id)),
    globalVariables: settings.getSetting(userId, 'macro_variables_global')?.value ?? {} };
}

export async function writeRuntimeState(userId: string, chatId: string, command: RuntimeStateCommand) {
  const chat = chats.getChat(userId, chatId);
  if (!chat) throw new Error('Runtime chat not found');
  let value: unknown;
  let patch: Record<string, unknown>;
  switch (command.kind) {
    case 'chat.metadata':
      value = chats.updateChat(userId, chatId, { metadata: { ...chat.metadata, [command.key]: command.value } });
      patch = { chat: value }; break;
    case 'chat.variables':
      value = chats.updateChat(userId, chatId, { metadata: { ...chat.metadata,
        chat_variables: { ...chat.metadata.chat_variables, ...command.values } } });
      patch = { chat: value }; break;
    case 'message.edit':
    case 'message.delete': {
      const message = chats.getMessage(userId, command.id);
      if (!message || message.chat_id !== chatId) throw new Error('Runtime message not found in this chat');
      if (command.kind === 'message.delete') {
        value = chats.deleteMessage(userId, command.id);
        patch = { deletedMessageId: command.id };
      } else {
        const updated = chats.updateMessage(userId, command.id, { content: command.content });
        if (!updated) throw new Error('Runtime message update failed');
        value = projectRuntimeMessage(updated); patch = { message: value };
      }
      break;
    }
    case 'message.create': {
      if (!['system', 'assistant', 'user'].includes(command.role)) throw new Error('Invalid runtime message role');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(command.id)) throw new Error('Invalid runtime message identifier');
      const message = chats.createMessage(chatId, { is_user: command.role === 'user', name: '', content: command.content,
        ...(command.role === 'system' ? { extra: { spindle_role: 'system' } } : {}) }, userId, command.id);
      value = projectRuntimeMessage(message); patch = { message: value }; break;
    }
    case 'character.update': {
      const { name, description, first_mes } = command.patch;
      const updated = characters.updateCharacter(userId, command.id, { name, description, first_mes });
      if (!updated) throw new Error('Runtime character not found');
      value = projectRuntimeCharacter(updated); patch = { character: value }; break;
    }
    case 'persona.update': {
      const { name, description } = command.patch;
      value = personas.updatePersona(userId, command.id, { name, description });
      if (!value) throw new Error('Runtime persona not found');
      patch = { persona: value }; break;
    }
    case 'lore.create':
      value = books.createEntry(userId, command.bookId, command.patch);
      if (!value) throw new Error('Runtime world book not found');
      patch = { loreEntry: value }; break;
    case 'lore.update':
      value = books.updateEntry(userId, command.id, command.patch);
      if (!value) throw new Error('Runtime lore entry not found');
      patch = { loreEntry: value }; break;
    case 'lore.delete':
      value = await books.deleteEntry(userId, command.id);
      if (!value) throw new Error('Runtime lore entry not found');
      patch = { deletedLoreId: command.id }; break;
    default: throw new Error('Unknown runtime state command');
  }
  return { revision: runtimeStateRevision(userId), value, patch };
}
