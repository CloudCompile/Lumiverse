import type { ToolDefinition } from "../../llm/types";
import type { RuntimeCouncilToolDefinition } from "../council/tool-runtime";
import {
  CARD_AGENT_TOOL_DEFINITIONS,
  executeCardAgentTool,
} from "../card-agent/tools.service";
import type { ToolActivity } from "../card-agent/tools.service";
import { getCardCreatorContext } from "./context";

/**
 * Card Creator tool surface for ordinary chat.
 *
 * The tools themselves are the Card Agent's — read-only library access plus
 * `propose_card_edit`. Only the framing differs: in a chat the scope is the
 * user's whole library, because the conversation is not bound to a selection
 * the way a sidecar session was.
 *
 * There is deliberately no write tool. The creator's turns can only file
 * proposals; the user applies them from the conversation.
 */

/** Names of the tools this feature contributes, used to recognise their results. */
export const CARD_CREATOR_TOOL_NAMES: ReadonlySet<string> = new Set(
  CARD_AGENT_TOOL_DEFINITIONS.map((tool) => tool.name),
);

/**
 * Tool definitions in the shape the inline dispatch expects.
 *
 * `execution: "host"` routes them through the host branch, which is where a
 * built-in (non-extension, non-MCP) tool belongs.
 */
export function getCardCreatorRuntimeTools(): Map<string, RuntimeCouncilToolDefinition> {
  const tools = new Map<string, RuntimeCouncilToolDefinition>();
  for (const definition of CARD_AGENT_TOOL_DEFINITIONS) {
    tools.set(definition.name, {
      name: definition.name,
      displayName: definition.name.replace(/_/g, " "),
      description: definition.description,
      category: "story_direction",
      execution: "host",
      inputSchema: definition.parameters,
      argsSchema: definition.parameters,
    });
  }
  return tools;
}

export function getCardCreatorToolDefinitions(): ToolDefinition[] {
  return CARD_AGENT_TOOL_DEFINITIONS;
}

export interface CardCreatorToolOutcome {
  result: string;
  isError: boolean;
  toolName: string;
  /** Ids of proposals this call filed, if any. */
  proposalIds?: number[];
  /** One-line summary for the transcript the user sees in the chat. */
  activity: ToolActivity;
}

/**
 * Run one Card Creator tool call.
 *
 * The chat the turn belongs to comes from the ambient turn context; without it
 * the proposal could not be attributed to a conversation, so the call is
 * refused rather than filed somewhere unreachable.
 */
export async function executeCardCreatorTool(
  name: string,
  args: Record<string, unknown>,
): Promise<CardCreatorToolOutcome> {
  const context = getCardCreatorContext();
  if (!context) {
    return {
      result:
        "Card tools are only available inside a conversation with the Card Creator.",
      isError: true,
      toolName: name,
      activity: {
        name,
        args,
        ok: false,
        summary: "No conversation context",
      },
    };
  }

  const executed = await executeCardAgentTool(
    {
      userId: context.userId,
      sessionId: "",
      chatId: context.chatId,
      // A chat is not scoped down to a selection: the creator can see the whole
      // library the same way the library page can.
      scope: null,
    },
    name,
    args,
  );

  return {
    result: executed.content,
    isError: !executed.ok,
    toolName: name,
    proposalIds: executed.proposalIds,
    activity: {
      name,
      args,
      ok: executed.ok,
      summary: executed.summary,
    },
  };
}
