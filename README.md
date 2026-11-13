# ステッカー店(Stripe Checkout 練習)

Node.js + Express + Stripe Checkout のミニショップ。商品は `products.json` の3つ。

## セットアップ

1. Stripe アカウントを作り、**テストモード**の Secret key(`sk_test_...`)を取得
   (ダッシュボード → 開発者 → API キー)
2. `.env.example` を `.env` にコピーしてキーを書き込む
   ```sh
   cp .env.example .env
   ```
3. 起動
   ```sh
   npm install
   npm start        # または npm run dev(ファイル変更で自動再起動)
   ```
4. http://localhost:3000 を開く

## テスト決済

- カード番号 `4242 4242 4242 4242`、有効期限は未来の日付、CVC は任意の3桁
- 結果はダッシュボード(テストモード)の「取引」で確認できます

## 仕組み

- ブラウザは商品IDと数量だけを `POST /checkout` に送る。価格はサーバーが `products.json` から引き、
  ブラウザから金額が送られてきても使わない
- 数量は 1〜10 の整数のみ受け付け、それ以外(`0`、`11`、`1.5`、`01`、空など)は 400 で拒否する
- `price_data` でその場で商品名・金額を渡すため、Stripe 側に商品登録は不要
- JPY は小数なし通貨なので `price`(円)をそのまま `unit_amount` に渡す
- 安全のため、テストキー以外(`sk_live_...`)では起動しない

## Webhook(支払い完了の記録)

支払いが完了すると Stripe が `POST /webhook` に `checkout.session.completed` を送り、
サーバーが署名を検証したうえで `orders.jsonl` に1行1注文で記録します(Git には入りません)。

ローカルで受け取るには [Stripe CLI](https://docs.stripe.com/stripe-cli) を使います。

```sh
stripe login                                         # 初回のみ
stripe listen --forward-to localhost:3000/webhook    # 表示される whsec_... を .env の STRIPE_WEBHOOK_SECRET へ
npm start                                            # 別のターミナルで
```

- 署名が合わないリクエストは 400 で拒否します
- 同じ Session のイベントが再送されても、二重には記録しません
- `STRIPE_WEBHOOK_SECRET` が未設定でもショップは動きますが、`/webhook` は 503 を返し注文は記録されません
- 記録先は環境変数 `ORDERS_FILE` で変更できます
