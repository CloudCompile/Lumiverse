import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import { BUNDLE_SETUP_PAGE } from "../src/runtime/bundle-setup-page";

// The tray app is a hidden-window Tauri shell; there is no visible UI.
// clearScreen off + fixed port per Tauri's Vite integration guidance.
export default defineConfig({
  plugins: [{
    name: "lumiverse-server-setup",
    transformIndexHtml: {
      order: "pre",
      handler(html, context) {
        return context.filename.endsWith("server-setup.html")
          ? BUNDLE_SETUP_PAGE.replace("</head>", '<script type="module" src="/src/server-setup.ts"></script></head>')
          : html;
      },
    },
  }],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        customUrl: fileURLToPath(new URL("./custom-url.html", import.meta.url)),
        serverSetup: fileURLToPath(new URL("./server-setup.html", import.meta.url)),
      },
    },
  },
});
