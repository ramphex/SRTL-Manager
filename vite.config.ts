import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => {
  const devMode = command === "serve";
  const webPort = Number(process.env.SRTL_WEB_PORT ?? (devMode ? 5178 : 5179));
  const apiTarget = process.env.SRTL_API_TARGET ?? `http://127.0.0.1:${devMode ? 3009 : 3010}`;
  const apiOrigin = new URL(apiTarget).origin;

  return {
    plugins: [react()],
    root: ".",
    server: {
      port: webPort,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          configure(proxy) {
            proxy.on("proxyReq", (proxyRequest) => {
              if (proxyRequest.hasHeader("origin")) proxyRequest.setHeader("origin", apiOrigin);
            });
          }
        },
        "/documentation": apiTarget
      }
    },
    preview: {
      port: webPort
    },
    build: {
      outDir: "dist/client"
    }
  };
});
