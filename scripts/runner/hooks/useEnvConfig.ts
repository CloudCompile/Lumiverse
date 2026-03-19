import { useState, useCallback, useEffect } from "react";
import { existsSync } from "fs";
import { ENV_FILE } from "../lib/constants.js";

export interface EnvConfig {
  port: number;
  trustAnyOrigin: boolean;
}

export interface EnvConfigApi extends EnvConfig {
  writeTrustAnyOrigin: (enable: boolean) => Promise<void>;
}

export function useEnvConfig(): EnvConfigApi {
  const [port, setPort] = useState(7860);
  const [trustAnyOrigin, setTrustAnyOrigin] = useState(false);

  // Read .env on mount
  useEffect(() => {
    (async () => {
      if (!existsSync(ENV_FILE)) return;
      const content = await Bun.file(ENV_FILE).text();
      const portMatch = content.match(/^PORT=(\d+)/m);
      if (portMatch) setPort(parseInt(portMatch[1], 10));
      setTrustAnyOrigin(/^TRUST_ANY_ORIGIN=true$/m.test(content));
    })();
  }, []);

  const writeTrustAnyOrigin = useCallback(
    async (enable: boolean) => {
      if (!existsSync(ENV_FILE)) return;

      let content = await Bun.file(ENV_FILE).text();

      if (enable) {
        if (/^#?\s*TRUST_ANY_ORIGIN=/m.test(content)) {
          content = content.replace(
            /^#?\s*TRUST_ANY_ORIGIN=.*/m,
            "TRUST_ANY_ORIGIN=true"
          );
        } else {
          content =
            content.trimEnd() +
            "\n\n# Remote / mobile access (managed by runner)\nTRUST_ANY_ORIGIN=true\n";
        }
      } else {
        content = content.replace(
          /^TRUST_ANY_ORIGIN=true.*$/m,
          "# TRUST_ANY_ORIGIN=true"
        );
      }

      await Bun.write(ENV_FILE, content);
      setTrustAnyOrigin(enable);
    },
    []
  );

  return { port, trustAnyOrigin, writeTrustAnyOrigin };
}
