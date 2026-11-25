import { join } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// The client is a plain SPA served by pigui's own server from dist/public; the server's static contract is unchanged.
export default defineConfig({
	root: "src/client",
	plugins: [svelte()],
	server: {
		// The app talks to pigui's own server; in dev, proxy /api to it (default the pigui port, override with PIGUI_DEV_API).
		proxy: {
			"/api": { target: process.env.PIGUI_DEV_API ?? "http://localhost:8787", changeOrigin: true },
		},
	},
	build: {
		outDir: join(import.meta.dirname, "dist", "public"),
		emptyOutDir: true,
		target: ["safari16", "chrome110"],
		sourcemap: true,
		rollupOptions: {
			output: {
				// The service worker precaches the emitted shell by name; the entry keeps a stable one.
				entryFileNames: "app.js",
				chunkFileNames: "chunks/[name]-[hash].js",
				assetFileNames: "assets/[name]-[hash][extname]",
			},
		},
	},
});
