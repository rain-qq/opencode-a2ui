import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 127.0.0.1 (not "localhost") — Node on Windows resolves "localhost" to
      // IPv6 ::1 first, but the server binds 0.0.0.0 (IPv4-only), so a
      // "localhost" target makes the proxy hang (→ "注册表加载失败" in the picker).
      "/api": "http://127.0.0.1:3001",
    },
  },
});
