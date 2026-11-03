// claude.ai アーティファクト用の1ファイルHTMLを作る。
//   npm run build:artifact  →  dist-artifact/bv-prr-tool.html
// アーティファクトは外部スクリプトを自前ホストから読めない（CSPで遮断）ため、
// Vite のビルド結果の JS をページ内に埋め込む。index.html の CSP meta は
// インラインスクリプトを止めてしまうので外し、アーティファクト側の CSP に任せる。
// <!doctype>/<html>/<head>/<body> は公開時にプラットフォームが付けるので書かない。
import { build } from "vite";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const outDir = "dist-artifact";
const tmpDir = join(outDir, ".vite");
rmSync(outDir, { recursive: true, force: true });
await build({ base: "./", logLevel: "warn", build: { outDir: tmpDir, emptyOutDir: true } });

const html = readFileSync(join(tmpDir, "index.html"), "utf8");
const jsFiles = readdirSync(join(tmpDir, "assets")).filter((f) => f.endsWith(".js"));
if (jsFiles.length !== 1) throw new Error(`JSチャンクが1つではありません: ${jsFiles.join(", ")}`);
const js = readFileSync(join(tmpDir, "assets", jsFiles[0]), "utf8").replace(/<\/script/gi, "<\\/script");
const cssFiles = readdirSync(join(tmpDir, "assets")).filter((f) => f.endsWith(".css"));
const css = cssFiles.map((f) => readFileSync(join(tmpDir, "assets", f), "utf8")).join("\n");

const style = html.match(/<style>([\s\S]*?)<\/style>/);
if (!style) throw new Error("index.html の <style> が見つかりません");
const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [, "BV / PRR 分析ツール"])[1];

const page = `<title>${title}</title>
<style>
      /* 画面は暗い配色のみ（単一テーマ）。背景と color-scheme を明示する */
      :root {
        color-scheme: dark;
      }
      body {
        background: #0b1220;
        color: #e7ecf3;
      }
${style[1]}
${css}
</style>
<div id="root"></div>
<script type="module">
${js}
</script>
`;
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "bv-prr-tool.html"), page);
rmSync(tmpDir, { recursive: true, force: true });
console.log(`${join(outDir, "bv-prr-tool.html")} (${(page.length / 1024).toFixed(0)} KB)`);
