import React from "react";
import { Box, Text, useStdout } from "ink";
import type { ServerState } from "../hooks/useServerProcess.js";
import type { UpdateState } from "../hooks/useGitOps.js";

interface HeaderBarProps {
  serverState: ServerState;
  port: number;
  pid: number | null;
  startedAt: number | null;
  isDev: boolean;
  currentBranch: string;
  trustAnyOrigin: boolean;
  updateState: UpdateState;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0)
    return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}

function StatusIndicator({
  state,
}: {
  state: ServerState;
}): React.ReactElement {
  switch (state) {
    case "starting":
      return <Text color="yellow">{"◐ Starting"}</Text>;
    case "running":
      return <Text color="green">{"● Running"}</Text>;
    case "stopping":
      return <Text color="yellow">{"◑ Stopping"}</Text>;
    case "stopped":
      return <Text color="gray">{"○ Stopped"}</Text>;
    case "crashed":
      return <Text color="red">{"✖ Crashed"}</Text>;
  }
}

function UpdateIndicator({
  updateState,
}: {
  updateState: UpdateState;
}): React.ReactElement | null {
  if (updateState.inProgress) {
    return <Text color="yellow">{"⟳ Updating…"}</Text>;
  }
  if (updateState.checking) {
    return <Text color="gray">{"⟳"}</Text>;
  }
  if (updateState.available) {
    return (
      <Text color="green">
        {"⬆ "}
        {updateState.commitsBehind}
        {" update"}
        {updateState.commitsBehind > 1 ? "s" : ""}
      </Text>
    );
  }
  return null;
}

// Gradient characters for LUMIVERSE
const LOGO_CHARS = [
  { char: "L", color: "#af87ff" },
  { char: "U", color: "#5f87ff" },
  { char: "M", color: "#87d7ff" },
  { char: "I", color: "#af87ff" },
  { char: "V", color: "#5f87ff" },
  { char: "E", color: "#87d7ff" },
  { char: "R", color: "#af87ff" },
  { char: "S", color: "#5f87ff" },
  { char: "E", color: "#87d7ff" },
];

export function HeaderBar({
  serverState,
  port,
  pid,
  startedAt,
  isDev,
  currentBranch,
  trustAnyOrigin,
  updateState,
}: HeaderBarProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;

  const uptime = startedAt ? formatUptime(Date.now() - startedAt) : "—";
  const pidStr = pid ? String(pid) : "—";
  const updateIndicator = <UpdateIndicator updateState={updateState} />;

  const branchColor =
    currentBranch === "main"
      ? "green"
      : currentBranch === "staging"
        ? "yellow"
        : "gray";

  return (
    <Box backgroundColor="#303030" width={cols} height={1}>
      <Text bold>
        {" "}
        {LOGO_CHARS.map((c, i) => (
          <Text key={i} color={c.color}>
            {c.char}
          </Text>
        ))}
        {" "}
      </Text>
      <Text color="gray">│</Text>
      <Text>
        {" "}
        <StatusIndicator state={serverState} />{" "}
      </Text>
      <Text color="gray">│</Text>
      <Text>
        {" "}
        <Text color="gray">Port</Text> <Text>{port}</Text>{" "}
      </Text>
      <Text color="gray">│</Text>
      <Text>
        {" "}
        <Text color="gray">PID</Text> <Text>{pidStr}</Text>{" "}
      </Text>
      <Text color="gray">│</Text>
      <Text>
        {" "}
        <Text color="gray">Uptime</Text> <Text>{uptime}</Text>{" "}
      </Text>
      <Text color="gray">│</Text>
      {updateIndicator && (
        <>
          <Text> {updateIndicator} </Text>
          <Text color="gray">│</Text>
        </>
      )}
      <Text>
        {" "}
        {isDev ? <Text color="yellow">DEV</Text> : <Text color="green">PROD</Text>}
        {" "}
      </Text>
      <Text color="gray">│</Text>
      <Text>
        {" "}
        <Text color={branchColor}>{currentBranch || "?"}</Text>{" "}
      </Text>
      {trustAnyOrigin && (
        <>
          <Text color="gray">│</Text>
          <Text color="yellow">{" ⚠ REMOTE "}</Text>
        </>
      )}
    </Box>
  );
}
