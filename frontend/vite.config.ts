import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: true, // bind to 0.0.0.0 so it's accessible from your Mac
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
