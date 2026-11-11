import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `base: "./"` drží cesty k assetům relativní, takže build funguje jak na
// uživatel.github.io/repo/, tak na vlastní doméně. Aplikace nemá klientské
// routování, takže relativní cesty nic nerozbijí.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
