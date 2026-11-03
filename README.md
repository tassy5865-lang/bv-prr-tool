# BV / PRR 分析ツール

透析ログCSV（Shift_JIS）をドロップして、PRR・ΔBV・除水・血圧を自動抽出・可視化するReactアプリです。

## Claude での総合分析について

このツールは2か所で公開しています。

| 公開先 | 「総合分析」の Claude ボタン | PDFレポート |
|---|---|---|
| **claude.ai のアーティファクト版**<br>https://claude.ai/artifact/5MmrcvtQxVyRywVNqW5JzV | **分析結果がそのまま画面に表示されます**（ご自身の Claude.ai アカウントの利用枠を使用。初回は利用の許可を求められます）。結果はコピーできます | 使えません（claude.ai の表示枠では印刷できないため）。抽出データはCSVで保存できます |
| **GitHub Pages 版**<br>https://tassy5865-lang.github.io/bv-prr-tool/ | Claude.ai が新しいタブで開き、分析依頼が入力欄に入った状態になります。送信すると分析が得られます | 使えます（分析結果は含まれません） |

- どちらも APIキーは使いません。
- 送られるのはセッションごとの集計値だけで、患者名は「患者A」などの仮名に置き換えます。「送る内容を確認」で送信内容を事前に確認できます。
- アーティファクト版を更新するときは `npm run build:artifact` で `dist-artifact/bv-prr-tool.html` を作り、同じアーティファクトに公開し直します。

## PDFレポート出力

各画面の「PDFレポート出力（印刷）」から、ブラウザの印刷機能で A4 のレポートを出力できます（印刷先で「PDFに保存」を選択）。
患者・実施日・抽出範囲などのヘッダー、ページ番号、注意書き付きで、グラフはページをまたいで分割されないようにレイアウトされます。

## セットアップ

```bash
npm install
npm run dev
```

## GitHub Pagesへのデプロイ

1. `vite.config.js` の `base` を、実際のリポジトリ名に合わせて書き換える
   （例: リポジトリ名が `bv-prr-tool` なら `base: "/bv-prr-tool/"`）
2. GitHubにリポジトリを作成してpush
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<あなたのユーザー名>/bv-prr-tool.git
   git push -u origin main
   ```
3. デプロイ
   ```bash
   npm run deploy
   ```
4. GitHubリポジトリの Settings → Pages で、公開ソースが `gh-pages` ブランチになっていることを確認
5. `https://<あなたのユーザー名>.github.io/bv-prr-tool/` で公開されます
