import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pagesで公開する場合、リポジトリ名に合わせて base を書き換えてください
// 例: リポジトリ名が "bv-prr-tool" なら base: "/bv-prr-tool/"
export default defineConfig({
  plugins: [react()],
  base: "/bv-prr-tool/",
});
