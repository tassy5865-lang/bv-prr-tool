# BV / PRR 分析ツール

透析ログCSV（Shift_JIS）をドロップして、PRR・ΔBV・除水・血圧を自動抽出・可視化するReactアプリです。

## AI総合分析用プロンプト生成について

このアプリには「分析用プロンプトを生成」ボタンがあります。APIキーは一切使わず、
読み込んだセッションデータから詳細な分析依頼プロンプトをブラウザ内で組み立てて表示するだけです。
生成されたプロンプトを「コピーする」ボタンでコピーし、ChatGPTやClaudeなど任意のAIチャットに
貼り付けることで、専門的な詳細分析を得られます。GitHub Pagesを含むどの環境でも動作します。

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
