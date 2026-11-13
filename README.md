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

## テスト購入の手順(Webhook の転送つき)

テストカードで購入し、Stripe CLI で Webhook を手元に転送して、注文が記録されるところまでを確かめる手順です。

- `.env` の `STRIPE_SECRET_KEY` はテストキー(`sk_test_...`)を使います
- **本物のカード情報は使いません。** 公式ドキュメントの[テスト用カード](https://docs.stripe.com/testing)だけを使ってください

### 1. Stripe CLI にログインする(初回のみ)

```sh
stripe login
```

ペアリングコードが表示されてブラウザでダッシュボードが開くので、コードを確認して許可します。
v1.50.0 より新しい CLI では、先に管理者がダッシュボードの
Settings → Team and security → **MCP and CLI access** で CLI アクセスを有効にしておく必要があります。

### 2. Webhook を手元のサーバーへ転送する(ターミナル A)

```sh
stripe listen --forward-to http://localhost:3000/webhook
```

`Ready! Your webhook signing secret is whsec_...` と表示されます。このターミナルは開いたままにします。
受け取るイベントをこのショップが使う2種類に絞る場合は、次のようにします。

```sh
stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded --forward-to http://localhost:3000/webhook
```

### 3. 署名用シークレットを `.env` に書く

表示された `whsec_...` を `.env` の `STRIPE_WEBHOOK_SECRET` に書きます。
この値は `stripe listen` を再起動しても変わりません。値だけを表示するには次のコマンドを使います。

```sh
stripe listen --print-secret
```

### 4. ショップを起動する(ターミナル B)

```sh
npm start
```

「STRIPE_WEBHOOK_SECRET が未設定」という警告が出なければ大丈夫です。

### 5. テストカードで購入する

http://localhost:3000 を開き、商品と数量を選んで「購入する」を押し、Stripe の決済ページで次のように入力します。

| 項目 | 入力値 |
|---|---|
| カード番号 | `4242 4242 4242 4242`(Visa、決済が成功する) |
| 有効期限 | 未来の日付(例:`12/34`) |
| CVC | 任意の3桁 |
| その他の項目 | 任意の値 |

支払うと `success.html` に移動します。

### 6. 注文が記録されたか確認する

- ターミナル A:`checkout.session.completed` が転送され、`[200]` が返っている
- ターミナル B:`注文を記録しました: ...` と表示される
- `cat orders.jsonl` で注文が1行追加されている
- ダッシュボード(テスト環境)の「取引」に支払いが表示される

### 7. 失敗するケースも試す(任意)

| カード番号 | 結果 |
|---|---|
| `4000 0000 0000 0002` | 決済が拒否される(`generic_decline`) |
| `4000 0000 0000 9995` | 残高不足で拒否される(`insufficient_funds`) |
| `4000 0027 6000 3184` | 必ず 3D セキュア認証の画面が出る |

拒否されたカードでは支払いが完了しないので、`orders.jsonl` には記録されません。

> `stripe trigger checkout.session.completed` でも Webhook を送れますが、Stripe のテスト環境に実際にオブジェクトが作られます。
> また `/checkout` を通らないため `metadata` が空になり、記録される注文の `productId` と `quantity` は `null` になります。
> 動作確認には上のブラウザでの購入をおすすめします。

## 仕組み

- ブラウザは商品IDと数量だけを `POST /checkout` に送る。価格はサーバーが `products.json` から引き、
  ブラウザから金額が送られてきても使わない
- 数量は 1〜10 の整数のみ受け付け、それ以外(`0`、`11`、`1.5`、`01`、空など)は 400 で拒否する
- `price_data` でその場で商品名・金額を渡すため、Stripe 側に商品登録は不要
- JPY は小数なし通貨なので `price`(円)をそのまま `unit_amount` に渡す
- 安全のため、テストキー以外(`sk_live_...`)では起動しない

## 自動テスト

```sh
npm test
```

本物の Stripe には接続しません。`stripe.webhooks.generateTestHeaderString` で偽の署名つきイベントを作り、
署名検証(正しい署名・違う署名・本文の書き換え)、同じイベントの再送、未払いイベントの扱いを確かめます。
Checkout Session の作成は偽物に差し替え、ブラウザから送った金額が使われないことも確かめます。
テスト中は外部への HTTP(S) 通信を遮断し、ダミーのキーと一時ファイルを使うので `.env` や `orders.jsonl` には触れません。

## Webhook(支払い完了の記録)

支払いが完了すると Stripe が `POST /webhook` に `checkout.session.completed` を送り、
サーバーが署名を検証したうえで `orders.jsonl` に1行1注文で記録します(Git には入りません)。

ローカルで受け取るには [Stripe CLI](https://docs.stripe.com/stripe-cli) を使います。
手順は上の「テスト購入の手順」を見てください。

- 署名が合わないリクエストは 400 で拒否します
- 同じ Session のイベントが再送されても、二重には記録しません
- `STRIPE_WEBHOOK_SECRET` が未設定でもショップは動きますが、`/webhook` は 503 を返し注文は記録されません
- 記録先は環境変数 `ORDERS_FILE` で変更できます
