import { join } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// The client is a plain SPA served by pigui's own server from dist/public; the server's static contract is unchanged.
export default defineConfig({
	root: "src/client",
	plugins: [svelte()],
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
