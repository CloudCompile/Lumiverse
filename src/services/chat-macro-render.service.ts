import { cloneEnv, evaluate, initMacros, registry, type MacroEnv } from "../macros";
import { withJsonBlocksProtected } from "../macros/json-blocks";
import { captureMessageLiterals, shieldMessageLiterals, withMessageLiteralExtra } from "../macros/message-literals";
import type { Message } from "../types/message";
import { healFormattingArtifacts } from "../utils/format-healing";
import * as chatsSvc from "./chats.service";

const HAS_MACRO_RE = /\{\{|<(?:user|char|bot)>/i;

interface ReconcileChatMessageMacrosInput {
  userId: string;
  chatId: string;
  messageIds: string[];
  macroEnvSeed?: MacroEnv;
  persistVariables?: boolean;
}

interface ResolveRenderedChatMessagesInput {
  messages: Message[];
  messageIds: string[];
  macroEnvSeed?: MacroEnv;
}

export async function resolveRenderedChatMessages(
  input: ResolveRenderedChatMessagesInput,
): Promise<{
  resolvedById: Map<string, string>;
  literalBracesById: Map<string, number[]>;
  globalVariables?: Record<string, string>;
  chatVariables?: Record<string, string>;
}> {
  const targetIds = [...new Set(input.messageIds.filter(Boolean))];
  const resolvedById = new Map<string, string>();
  const literalBracesById = new Map<string, number[]>();
  if (!input.macroEnvSeed || input.macroEnvSeed.extra.preserveMessageSource || targetIds.length === 0) return { resolvedById, literalBracesById };

  const targetSet = new Set(targetIds);
  let lastTargetIdx = -1;
  let shouldReplay = false;
  for (let i = 0; i < input.messages.length; i++) {
    if (!targetSet.has(input.messages[i].id)) continue;
    lastTargetIdx = i;
    if (HAS_MACRO_RE.test(input.messages[i].content)) shouldReplay = true;
  }
  if (lastTargetIdx < 0 || !shouldReplay) return { resolvedById, literalBracesById };

  initMacros();
  const env = cloneEnv(input.macroEnvSeed);

  for (let i = 0; i <= lastTargetIdx; i++) {
    const message = input.messages[i];
    if (message.extra?.hidden === true) continue;
    const source = shieldMessageLiterals(message.content, message);
    const rendered = HAS_MACRO_RE.test(message.content)
      ? await resolveMessageMacroContent(source, env)
      : captureMessageLiterals(source);
    if (targetSet.has(message.id)) {
      resolvedById.set(message.id, rendered.content);
      literalBracesById.set(message.id, rendered.literalBraces);
    }
  }

  return {
    resolvedById,
    literalBracesById,
    globalVariables: Object.fromEntries(env.variables.global),
    chatVariables: Object.fromEntries(env.variables.chat),
  };
}

export async function resolveRenderedMessageContent(
  content: string,
  env: MacroEnv,
  deferLiteralBraceRestore = false,
): Promise<string> {
  const rendered = await resolveMessageMacroContent(content, env);
  return deferLiteralBraceRestore ? rendered.template : rendered.content;
}

/** Keep literal positions until the caller has persisted the message's provenance. */
export async function resolveMessageMacroContent(content: string, env: MacroEnv) {
  if (env.extra.preserveMessageSource) return { content, template: content, literalBraces: [] as number[] };
  const template = await resolveMessageMacroTemplate(content, env);
  return { ...captureMessageLiterals(template), template };
}

async function resolveMessageMacroTemplate(content: string, env: MacroEnv): Promise<string> {
  if (env.extra.preserveMessageSource || !HAS_MACRO_RE.test(content)) return content;
  initMacros();
  return withJsonBlocksProtected(content, env, async (protectedContent) =>
    healFormattingArtifacts((await evaluate(protectedContent, env, registry, { deferLiteralBraceRestore: true })).text),
  );
}

export function buildPersistedMacroVariables(
  existingMacroVars: Record<string, unknown>,
  incomingGlobal: Record<string, string>,
): Record<string, unknown> {
  const existingGlobal = (existingMacroVars.global as Record<string, string> | undefined) ?? {};
  return {
    ...existingMacroVars,
    global: { ...existingGlobal, ...incomingGlobal },
  };
}

export function persistMacroVariableState(
  userId: string,
  chatId: string,
  env: MacroEnv,
): void {
  const chat = chatsSvc.getChat(userId, chatId);
  if (!chat) return;

  const existingMacroVars = (chat.metadata?.macro_variables as Record<string, unknown> | undefined) ?? {};
  const existingChatVars = (chat.metadata?.chat_variables as Record<string, string> | undefined) ?? {};
  chatsSvc.mergeChatMetadata(userId, chatId, {
    macro_variables: buildPersistedMacroVariables(existingMacroVars, Object.fromEntries(env.variables.global)),
    chat_variables: { ...existingChatVars, ...Object.fromEntries(env.variables.chat) },
  });
}

export async function reconcileChatMessageMacros(
  input: ReconcileChatMessageMacrosInput,
): Promise<Map<string, string>> {
  const messages = chatsSvc.getMessages(input.userId, input.chatId);
  if (messages.length === 0) return new Map<string, string>();

  const {
    resolvedById,
    literalBracesById,
    globalVariables,
    chatVariables,
  } = await resolveRenderedChatMessages({
    messages,
    messageIds: input.messageIds,
    macroEnvSeed: input.macroEnvSeed,
  });

  for (const [messageId, resolved] of resolvedById) {
    const existing = chatsSvc.getMessage(input.userId, messageId);
    if (!existing) continue;
    const extra = withMessageLiteralExtra(existing.extra, {
      content: resolved, literalBraces: literalBracesById.get(messageId) ?? [],
    });
    if (existing.content === resolved && JSON.stringify(extra) === JSON.stringify(existing.extra)) continue;
    chatsSvc.updateMessage(input.userId, messageId, { content: resolved, extra });
  }

  if (input.persistVariables !== false && globalVariables && chatVariables) {
    const chat = chatsSvc.getChat(input.userId, input.chatId);
    // Env values win on collision but concurrent extension writes survive.
    const existingMacroVars = (chat?.metadata?.macro_variables as Record<string, unknown> | undefined) ?? {};
    const existingChatVars = (chat?.metadata?.chat_variables as Record<string, string> | undefined) ?? {};
    chatsSvc.mergeChatMetadata(input.userId, input.chatId, {
      macro_variables: buildPersistedMacroVariables(existingMacroVars, globalVariables),
      chat_variables: { ...existingChatVars, ...chatVariables },
    });
  }

  return resolvedById;
}
