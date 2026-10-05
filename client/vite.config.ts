import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // Listen on the LAN too, so other devices can join at http://<this-pc-ip>:5173
    host: true,
    // Forward Socket.IO to the game server so the client always connects same-origin.
    proxy: {
      '/socket.io': { target: 'http://localhost:2567', ws: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
  },
});
