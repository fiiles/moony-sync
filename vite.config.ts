import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// The admin interface: root admin-ui, output admin-ui/dist (served by the server at "/").
export default defineConfig({
  root: "admin-ui",
  plugins: [preact()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The page's content security policy has no data: in font-src or style-src: nothing inlined.
    assetsInlineLimit: 0,
  },
});
