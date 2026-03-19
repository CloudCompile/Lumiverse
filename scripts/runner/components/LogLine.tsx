import React from "react";
import { Box, Text } from "ink";
import type { LogEntry } from "../hooks/useLogBuffer.js";

interface LogLineProps {
  entry: LogEntry;
}

const SOURCE_LABELS: Record<string, string> = {
  stdout: "   ",
  stderr: "ERR",
  system: "SYS",
};

const SOURCE_COLORS: Record<string, string | undefined> = {
  stdout: undefined,
  stderr: "red",
  system: "blue",
};

export function LogLine({ entry }: LogLineProps): React.ReactElement {
  const label = SOURCE_LABELS[entry.source] ?? "   ";
  const color = SOURCE_COLORS[entry.source];

  return (
    <Box>
      <Text dimColor>{entry.timestamp}</Text>
      <Text> </Text>
      <Text color={color}>{label}</Text>
      <Text> {entry.text}</Text>
    </Box>
  );
}
