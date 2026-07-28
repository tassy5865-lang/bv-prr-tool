# BV / PRR 分析ツール

透析ログCSV（Shift_JIS）をドロップして、PRR・ΔBV・除水・血圧を自動抽出・可視化するReactアプリです。

## ⚠️ 注意: AI総合分析ボタンについて

このアプリには「AIで総合分析する」ボタンがあり、Claude.aiのアーティファクト上では
Anthropicの内部プロキシ経由でClaude APIを直接呼び出せます。

**GitHub Pagesなど、Claude.ai以外の環境にデプロイするとこのボタンは動作しません。**
（APIキーの受け渡しがClaude.aiのアーティファクト機能に依存しているためです。）

使う場合は以下のいずれかが必要です:
- 自分のAnthropic APIキーを使うバックエンド（サーバーレス関数など）を用意し、
  `src/App.jsx` 内の `fetch("https://api.anthropic.com/v1/messages", ...)` を
  その自作エンドポイントに向ける
- このボタン・機能自体を削除する（該当箇所は `runAiAnalysis` 関数とその呼び出しUI）

APIキーをブラウザ側のコードに直接埋め込むのは絶対にやめてください（誰でも盗み見・悪用できます）。

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
