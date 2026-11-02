import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `npm run dev` serves the UI on :5173 and forwards API calls to the Python server.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // livekit-client (~530 kB) is its own chunk, loaded only when a call starts.
  build: { chunkSizeWarningLimit: 600 },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:4331", "/crm": "http://127.0.0.1:4331" },
  },
});
