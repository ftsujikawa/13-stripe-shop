// 本物の Stripe には接続せずに、Webhook の署名検証と Checkout の金額の扱いを確かめるテスト。
// 実行: npm test
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

// --- 本物の Stripe に絶対つながらないようにする -----------------------------
// stripe パッケージは http/https.request で通信するので、テスト中は呼ばれた時点で失敗させる
const blockNetwork = () => {
  throw new Error('テスト中に外部への HTTP(S) 通信が発生しました');
};
https.request = blockNetwork;
const realHttpRequest = http.request;
http.request = (...args) => {
  // テスト対象のローカルサーバー(127.0.0.1)への fetch は Node 内部の undici を使うので
  // ここを通らないが、念のため localhost 以外は拒否する
  const opts = typeof args[0] === 'object' && !(args[0] instanceof URL) ? args[0] : new URL(args[0]);
  const host = opts.hostname || opts.host;
  if (host !== '127.0.0.1' && host !== 'localhost') blockNetwork();
  return realHttpRequest(...args);
};

// --- テスト用の設定(.env より先に環境変数を入れる。dotenv は既存の値を上書きしない) ---
const WEBHOOK_SECRET = 'whsec_test_dummy_secret_for_unit_tests';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stripe-shop-test-'));
const ORDERS_FILE = path.join(tmpDir, 'orders.jsonl');
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_not_a_real_key';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.ORDERS_FILE = ORDERS_FILE;
process.env.BASE_URL = 'http://localhost:3000';

const { app, stripe } = require('../server.js');
const products = require('../products.json');

let server;
let baseUrl;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const readOrders = () =>
  fs.existsSync(ORDERS_FILE)
    ? fs.readFileSync(ORDERS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

// --- 偽の Webhook イベントを作るヘルパー --------------------------------------
let seq = 0;
function makeEvent({ type = 'checkout.session.completed', paymentStatus = 'paid', sessionId } = {}) {
  seq += 1;
  return {
    id: `evt_test_${seq}`,
    object: 'event',
    type,
    data: {
      object: {
        id: sessionId ?? `cs_test_${seq}`,
        object: 'checkout.session',
        payment_status: paymentStatus,
        amount_total: 1000,
        currency: 'jpy',
        metadata: { productId: products[0].id, quantity: '2' },
        customer_details: { email: 'buyer@example.com' },
      },
    },
  };
}

// stripe パッケージのテスト用ヘルパーで Stripe-Signature ヘッダーを作る
function sign(payload, secret = WEBHOOK_SECRET) {
  return stripe.webhooks.generateTestHeaderString({ payload, secret });
}

function postWebhook(body, signature) {
  const headers = { 'content-type': 'application/json' };
  if (signature !== undefined) headers['stripe-signature'] = signature;
  return fetch(`${baseUrl}/webhook`, { method: 'POST', headers, body });
}

// --- Webhook の署名検証 -----------------------------------------------------

test('正しい署名のイベントは受け付けて注文を記録する', async () => {
  const event = makeEvent();
  const payload = JSON.stringify(event);
  const res = await postWebhook(payload, sign(payload));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true });
  const order = readOrders().find((o) => o.sessionId === event.data.object.id);
  assert.ok(order, '注文が記録されていない');
  assert.equal(order.productId, products[0].id);
  assert.equal(order.quantity, 2);
  assert.equal(order.amount, 1000);
  assert.equal(order.currency, 'jpy');
});

test('違うシークレットで作った署名は 400 で拒否し、記録しない', async () => {
  const event = makeEvent();
  const payload = JSON.stringify(event);
  const res = await postWebhook(payload, sign(payload, 'whsec_wrong_secret'));

  assert.equal(res.status, 400);
  assert.equal(readOrders().some((o) => o.sessionId === event.data.object.id), false);
});

test('署名ヘッダーがない・壊れている場合も 400', async () => {
  const payload = JSON.stringify(makeEvent());
  assert.equal((await postWebhook(payload)).status, 400);
  assert.equal((await postWebhook(payload, 'garbage')).status, 400);
});

test('署名後に本文を書き換えると 400 で拒否し、記録しない', async () => {
  const event = makeEvent({ paymentStatus: 'unpaid' });
  const original = JSON.stringify(event);
  const signature = sign(original);

  // 署名した後で「未払い」を「支払い済み」に書き換えて送る(攻撃の想定)
  const tampered = original.replace('"payment_status":"unpaid"', '"payment_status":"paid"');
  assert.notEqual(tampered, original);
  const res = await postWebhook(tampered, signature);

  assert.equal(res.status, 400);
  assert.equal(readOrders().some((o) => o.sessionId === event.data.object.id), false);
});

test('同じイベントが2回届いても注文は1件だけ記録する', async () => {
  const event = makeEvent();
  const payload = JSON.stringify(event);

  const first = await postWebhook(payload, sign(payload));
  const second = await postWebhook(payload, sign(payload));

  assert.equal(first.status, 200);
  assert.equal(second.status, 200); // 再送を止めるため 2 回目も 200 を返す
  const matches = readOrders().filter((o) => o.sessionId === event.data.object.id);
  assert.equal(matches.length, 1);
});

test('同じ Session の completed と async_payment_succeeded が両方届いても1件だけ', async () => {
  const sessionId = 'cs_test_both_events';
  for (const type of ['checkout.session.completed', 'checkout.session.async_payment_succeeded']) {
    const payload = JSON.stringify(makeEvent({ type, sessionId }));
    assert.equal((await postWebhook(payload, sign(payload))).status, 200);
  }
  assert.equal(readOrders().filter((o) => o.sessionId === sessionId).length, 1);
});

test('未払い (payment_status=unpaid) の完了イベントは 200 を返すが記録しない', async () => {
  const event = makeEvent({ paymentStatus: 'unpaid' });
  const payload = JSON.stringify(event);
  const res = await postWebhook(payload, sign(payload));

  assert.equal(res.status, 200);
  assert.equal(readOrders().some((o) => o.sessionId === event.data.object.id), false);
});

test('関係ない種類のイベントは 200 を返すが記録しない', async () => {
  const event = makeEvent({ type: 'payment_intent.created' });
  const payload = JSON.stringify(event);
  const res = await postWebhook(payload, sign(payload));

  assert.equal(res.status, 200);
  assert.equal(readOrders().some((o) => o.sessionId === event.data.object.id), false);
});

// --- Checkout:ブラウザから送った金額は使わない --------------------------------

let createCalls;
beforeEach(() => {
  createCalls = [];
  // Checkout Session 作成を偽物に差し替え、渡された引数を記録する
  stripe.checkout.sessions.create = async (params) => {
    createCalls.push(params);
    return { id: 'cs_test_fake', url: 'https://checkout.stripe.com/c/pay/cs_test_fake' };
  };
});

function postCheckout(fields) {
  return fetch(`${baseUrl}/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
}

test('ブラウザから金額を送っても無視し、products.json の価格を使う', async () => {
  const product = products[0];
  const res = await postCheckout({
    productId: product.id,
    quantity: '3',
    // 改ざんされたフォームから送られてきそうな値
    price: '1',
    amount: '1',
    unit_amount: '1',
    currency: 'usd',
    name: '偽の商品名',
  });

  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_test_fake');
  assert.equal(createCalls.length, 1);

  const [item] = createCalls[0].line_items;
  assert.equal(item.price_data.unit_amount, product.price);
  assert.equal(item.price_data.currency, 'jpy');
  assert.equal(item.price_data.product_data.name, product.name);
  assert.equal(item.quantity, 3);
  assert.deepEqual(createCalls[0].metadata, { productId: product.id, quantity: '3' });
  // ブラウザの値が Stripe に渡す引数のどこにも紛れ込んでいないこと
  assert.equal(JSON.stringify(createCalls[0]).includes('偽の商品名'), false);
});

test('不明な商品・不正な数量は Stripe を呼ばずに 400', async () => {
  assert.equal((await postCheckout({ productId: 'no-such-product', quantity: '1' })).status, 400);
  for (const quantity of ['0', '11', '1.5', '01', '', '-1', '1e1']) {
    const res = await postCheckout({ productId: products[0].id, quantity });
    assert.equal(res.status, 400, `quantity=${JSON.stringify(quantity)} が拒否されていない`);
  }
  assert.equal(createCalls.length, 0);
});
