require('dotenv').config({ quiet: true });

const path = require('node:path');
const express = require('express');
const Stripe = require('stripe');
const products = require('./products.json');

// --- 設定の読み込みとチェック ---------------------------------------------
const { STRIPE_SECRET_KEY, BASE_URL = 'http://localhost:3000' } = process.env;
const PORT = Number(process.env.PORT) || 3000;

if (!STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY が未設定です。.env.example を .env にコピーしてキーを書いてください。');
  process.exit(1);
}
// 練習用なのでテストキー以外では起動しない(本番キーの誤使用を防ぐ)
if (!/^(sk|rk)_test_/.test(STRIPE_SECRET_KEY)) {
  console.error('STRIPE_SECRET_KEY はテスト用キー (sk_test_...) を使ってください。');
  process.exit(1);
}

const stripe = Stripe(STRIPE_SECRET_KEY);
const productsById = new Map(products.map((p) => [p.id, p]));

// --- アプリ本体 -------------------------------------------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const yen = (n) => `¥${n.toLocaleString('ja-JP')}`;

// 商品一覧
app.get('/', (req, res) => {
  const cards = products
    .map(
      (p) => `
      <li class="card">
        <h2>${escapeHtml(p.name)}</h2>
        <p class="price">${yen(p.price)}<span>(税込)</span></p>
        <form method="post" action="/checkout">
          <input type="hidden" name="productId" value="${escapeHtml(p.id)}">
          <button type="submit">購入する</button>
        </form>
      </li>`
    )
    .join('');

  res.send(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ステッカー店</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <main>
    <h1>ステッカー店</h1>
    <p class="note">テストモードです。実際の請求は発生しません。</p>
    <ul class="grid">${cards}</ul>
  </main>
</body>
</html>`);
});

// Checkout Session を作って Stripe の決済ページへ送る
app.post('/checkout', async (req, res) => {
  // ブラウザからは商品IDだけを受け取り、価格は必ずサーバー側の products.json から引く
  const product = productsById.get(req.body.productId);
  if (!product) {
    return res.status(400).send('不明な商品です。');
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'jpy', // JPY は小数なし通貨なので円の整数をそのまま渡す
            unit_amount: product.price,
            product_data: { name: product.name },
          },
        },
      ],
      metadata: { productId: product.id },
      success_url: `${BASE_URL}/success.html`,
      cancel_url: `${BASE_URL}/cancel.html`,
    });
    res.redirect(303, session.url);
  } catch (err) {
    console.error('Checkout Session の作成に失敗しました:', err.message);
    res.status(500).send('決済ページを開けませんでした。時間をおいて再度お試しください。');
  }
});

app.listen(PORT, () => {
  console.log(`ステッカー店を起動しました: ${BASE_URL}`);
});
