import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Chat context for Card Creator tool calls.
 *
 * The inline tool dispatch signature is shared by every tool family (MCP,
 * extension, host, council), so it has no slot for "which chat is this turn
 * part of". Proposals have to be attributed to a chat — that is how the review
 * queue finds them — so the generating turn publishes its context here and the
 * tool executor reads it, rather than widening the shared signature.
 */
export interface CardCreatorTurnContext {
  userId: string;
  chatId: string;
  /** Message the proposals will be attached to, once it exists. */
  messageId?: string;
}

const turnContext = new AsyncLocalStorage<CardCreatorTurnContext>();

export function runWithCardCreatorContext<T>(
  context: CardCreatorTurnContext,
  fn: () => T,
): T {
  return turnContext.run(context, fn);
}

export function getCardCreatorContext(): CardCreatorTurnContext | undefined {
  return turnContext.getStore();
}
