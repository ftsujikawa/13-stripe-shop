require('dotenv').config({ quiet: true });

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const Stripe = require('stripe');
const products = require('./products.json');

// --- 設定の読み込みとチェック ---------------------------------------------
const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, BASE_URL = 'http://localhost:3000' } = process.env;
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

if (!STRIPE_WEBHOOK_SECRET) {
  console.warn('STRIPE_WEBHOOK_SECRET が未設定のため、Webhook (/webhook) は無効です。注文は記録されません。');
}

const stripe = Stripe(STRIPE_SECRET_KEY);
const productsById = new Map(products.map((p) => [p.id, p]));

// --- 注文の記録(orders.jsonl に1行1注文で追記) ---------------------------
const ORDERS_FILE = process.env.ORDERS_FILE || path.join(__dirname, 'orders.jsonl');
// 同じイベントが再送されても二重に記録しないよう、記録済みの Session ID を覚えておく
const recordedSessionIds = new Set(
  fs.existsSync(ORDERS_FILE)
    ? fs.readFileSync(ORDERS_FILE, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).sessionId)
    : []
);

function recordOrder(session) {
  if (recordedSessionIds.has(session.id)) {
    console.log(`注文は記録済みです: ${session.id}`);
    return;
  }
  const order = {
    sessionId: session.id,
    productId: session.metadata?.productId ?? null,
    quantity: session.metadata?.quantity ? Number(session.metadata.quantity) : null,
    amount: session.amount_total,
    currency: session.currency,
    email: session.customer_details?.email ?? null,
    paidAt: new Date().toISOString(),
  };
  fs.appendFileSync(ORDERS_FILE, JSON.stringify(order) + '\n');
  recordedSessionIds.add(session.id);
  console.log(`注文を記録しました: ${order.productId} ${order.amount} ${order.currency}`);
}

// --- アプリ本体 -------------------------------------------------------------
const app = express();

// Webhook:署名検証に「生の」リクエストボディが必要なので、他のパーサーより先に定義する
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send('Webhook is not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.warn('Webhook の署名検証に失敗しました:', err.message);
    return res.status(400).send('Invalid signature');
  }

  switch (event.type) {
    // カード払いは完了時点で paid。後から入金される支払い方法は async_payment_succeeded で届く
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object;
      if (session.payment_status === 'paid') {
        recordOrder(session);
      }
      break;
    }
    default:
      // 他のイベントは使わないが、受け取ったことは 200 で返す
      break;
  }

  res.json({ received: true });
});

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const yen = (n) => `¥${n.toLocaleString('ja-JP')}`;

// 数量は 1〜10 の整数だけ受け付ける(フォームの min/max はブラウザ側の目安で、判定はここで行う)
const MIN_QUANTITY = 1;
const MAX_QUANTITY = 10;
function parseQuantity(value) {
  // "1"〜"10" の文字列だけを許可する。"1.5" "01" "1e1" " 2" や配列(同名フィールドの重複)は拒否
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  const n = Number(value);
  return n >= MIN_QUANTITY && n <= MAX_QUANTITY ? n : null;
}

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
          <label class="qty">数量
            <input type="number" name="quantity" value="1" min="${MIN_QUANTITY}" max="${MAX_QUANTITY}" step="1" required>
          </label>
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
  // ブラウザからは商品IDと数量だけを受け取る。価格は必ずサーバー側の products.json から引き、
  // ブラウザから金額などが送られてきても一切使わない
  const product = productsById.get(req.body.productId);
  if (!product) {
    return res.status(400).send('不明な商品です。');
  }
  const quantity = parseQuantity(req.body.quantity);
  if (quantity === null) {
    return res.status(400).send(`数量は ${MIN_QUANTITY}〜${MAX_QUANTITY} の整数で指定してください。`);
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity,
          price_data: {
            currency: 'jpy', // JPY は小数なし通貨なので円の整数をそのまま渡す
            unit_amount: product.price,
            product_data: { name: product.name },
          },
        },
      ],
      metadata: { productId: product.id, quantity: String(quantity) },
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
