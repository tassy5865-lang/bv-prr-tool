# BV / PRR 分析ツール

透析ログCSV（Shift_JIS）をドロップして、PRR・ΔBV・除水・血圧を自動抽出・可視化するReactアプリです。

## Claude.ai での総合分析について

「総合分析」画面の「Claude.ai で分析する」ボタンを押すと、Claude.ai が新しいタブで開き、
読み込んだセッションの集計値をもとにした分析依頼が入力欄に入った状態になります。内容を確認して送信するだけで分析が得られます。

- APIキーは使いません。ご自身の Claude.ai アカウント（ログインが必要）で分析します。GitHub Pages を含むどの環境でも動作します。
- 送られるのはセッションごとの集計値だけで、患者名は「患者A」などの仮名に置き換えます。「送る内容を確認」で送信内容を事前に確認できます。
- セッション数が多く自動入力できない場合は、クリップボードにコピーした上で Claude.ai を開くので、入力欄に貼り付けて送信してください。

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
