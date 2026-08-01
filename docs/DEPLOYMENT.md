# デプロイ・ロールバック・シークレット運用

Cloudflare **Workers** へのデプロイと、その後の切り戻し・秘密情報の更新手順。
このプロジェクトはバインディングを持たない（都市生成はブラウザ内で完結する）ため、
`wrangler.toml` に設定するのは Worker 名とエントリだけ。

## デプロイ

```bash
bun run deploy
```

`vite build && wrangler deploy` を実行する。ビルド成果物ではなく
`wrangler.toml` の `main`（`./src/ssr.tsx`）がエントリで、Cloudflare 連携は
`@cloudflare/vite-plugin` が担う（ADR-0007）。

デプロイ前に確認すること:

- `bun run check` と `bun run typecheck` と `bun run test` が通っている
- 本番の秘密情報が `wrangler secret` に登録済み（下記）

## デプロイ状況の確認

```bash
wrangler deployments list   # 直近のデプロイ一覧
wrangler versions list      # 直近のバージョン一覧（Version ID を取得する）
```

## ロールバック

```bash
wrangler rollback                  # 直前のバージョンへ戻す
wrangler rollback <VERSION_ID>     # 指定バージョンへ戻す
```

`<VERSION_ID>` は `wrangler versions list` で確認する。引数を省略すると最新の
1つ前が対象になる。


## シークレット

このプロジェクトはアプリケーション秘密を持たない。都市生成はブラウザ内で完結し、
Worker は SSR シェルと静的アセットを返すだけなので、`wrangler.toml` に `[secrets]`
ブロックは無く、`bun run deploy` に事前登録は要らない。

将来 API キーなどを持つようになったときの運用だけ、先に決めておく（ADR-0017）。

```bash
wrangler secret list          # 登録済みの名前を確認（値は出ない）
wrangler secret put <NAME>    # 値は対話的に入力する
wrangler secret delete <NAME>
```

**値をコマンドラインに書かないこと。** `wrangler secret put` は値を対話的に受け取り
エコーもしない。`wrangler secret bulk` に JSON をパイプする形は、既定のシェルでは
実値がヒストリファイルに残るので使わない（ADR-0017: 秘密は一時的にもファイルへ
書かない）。同じ理由で `wrangler deploy --secrets-file <path>` も使わない。

`wrangler.toml` の `[secrets] required` に名前を宣言すると、その名前は
デプロイ時に必須になる。**登録を先に、宣言を後に**。逆順にすると既存 Worker の
デプロイが必須チェックで失敗する。

ローテーションは「新しい値を登録 → 動作確認 → 発行元で旧い値を失効」の順。
逆順にすると、失効から反映までの間その秘密を使う経路が落ちる。
`wrangler secret put` は即時反映される（再デプロイ不要）。
