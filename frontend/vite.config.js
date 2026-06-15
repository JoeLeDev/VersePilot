import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/search-verse": "http://localhost:4000",
      "/detect-references": "http://localhost:4000",
      "/send-to-propresenter": "http://localhost:4000",
      "/propresenter": "http://localhost:4000",
      "/transcribe": "http://localhost:4000",
      "/transcribe-offline": "http://localhost:4000",
      "/stt": { target: "http://localhost:4000", ws: true },
      "/health": "http://localhost:4000",
      "/bible": "http://localhost:4000",
    },
  },
});
