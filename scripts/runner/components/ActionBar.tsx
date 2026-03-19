import React from "react";
import { Box, Text } from "ink";
import type { ServerState } from "../hooks/useServerProcess.js";
import type { UpdateState } from "../hooks/useGitOps.js";
import type { PendingConfirmation } from "../hooks/useConfirmation.js";

interface ActionBarProps {
  serverState: ServerState;
  updateState: UpdateState;
  trustAnyOrigin: boolean;
  branchSwitchInProgress: boolean;
  pending: PendingConfirmation | null;
  scrollOffset: number;
}

function ActionKey({
  letter,
  label,
  color = "blue",
}: {
  letter: string;
  label: string;
  color?: string;
}): React.ReactElement {
  return (
    <Text>
      <Text color={color}>{letter}</Text>
      <Text color="gray">{label}</Text>
    </Text>
  );
}

function Sep(): React.ReactElement {
  return <Text color="gray">{"  │  "}</Text>;
}

export function ActionBar({
  updateState,
  trustAnyOrigin,
  branchSwitchInProgress,
  pending,
  scrollOffset,
}: ActionBarProps): React.ReactElement {
  // Trust toggle label
  let trustLabel: React.ReactElement;
  if (pending?.type === "trust") {
    trustLabel = <ActionKey letter="T" label=" Confirm Remote" color="yellow" />;
  } else if (trustAnyOrigin) {
    trustLabel = <ActionKey letter="T" label=" Disable Remote" color="yellow" />;
  } else {
    trustLabel = <ActionKey letter="T" label=" Remote Access" />;
  }

  // Vector reset label
  let vectorLabel: React.ReactElement;
  if (pending?.type === "vector") {
    vectorLabel = <ActionKey letter="V" label=" Confirm Reset" color="yellow" />;
  } else {
    vectorLabel = <ActionKey letter="V" label=" Reset Vectors" color="red" />;
  }

  // Branch switch label
  let branchLabel: React.ReactElement;
  if (pending?.type === "branch") {
    branchLabel = (
      <ActionKey
        letter="B"
        label={` Confirm → ${pending.target}`}
        color="yellow"
      />
    );
  } else if (branchSwitchInProgress) {
    branchLabel = <ActionKey letter="B" label=" Switching…" color="yellow" />;
  } else {
    branchLabel = <ActionKey letter="B" label="ranch" />;
  }

  return (
    <Box justifyContent="space-between" height={1}>
      <Box>
        <Text> </Text>
        <ActionKey letter="R" label="estart" />
        {updateState.available && (
          <>
            <Sep />
            <ActionKey letter="U" label="pdate" color="green" />
          </>
        )}
        <Sep />
        {branchLabel}
        <Sep />
        {trustLabel}
        <Sep />
        {vectorLabel}
        <Sep />
        <ActionKey letter="O" label="pen Browser" />
        <Sep />
        <ActionKey letter="C" label="lear Log" />
        <Sep />
        <ActionKey letter="↑↓" label=" Scroll" />
        <Sep />
        <ActionKey letter="Q" label="uit" />
      </Box>
      {scrollOffset > 0 && (
        <Text color="yellow">
          {" ↑ "}{scrollOffset}{" lines above "}
        </Text>
      )}
    </Box>
  );
}
