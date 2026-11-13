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

- ブラウザは商品IDだけを `POST /checkout` に送る。価格はサーバーが `products.json` から引く
- `price_data` でその場で商品名・金額を渡すため、Stripe 側に商品登録は不要
- JPY は小数なし通貨なので `price`(円)をそのまま `unit_amount` に渡す
- 安全のため、テストキー以外(`sk_live_...`)では起動しない

## 今後

- Webhook(`checkout.session.completed`)で支払い完了を記録する
