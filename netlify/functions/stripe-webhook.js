// ═══════════════════════════════════════════════════════════
// APPS ON PURPOSE — STRIPE WEBHOOK
// Netlify Serverless Function
// Endpoint: https://aopnow.netlify.app/.netlify/functions/stripe-webhook
// ═══════════════════════════════════════════════════════════

const https = require('https');
const crypto = require('crypto');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const GHL_WEBHOOK_URL = process.env.GHL_WEBHOOK_URL || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 're@elvt.social';
const FROM_NAME = process.env.FROM_NAME || 'ELVT Social — Apps on Purpose';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'kendryah@highticketpurpose.com';

const PLAN_NAMES = {
  'price_1T3gqo0490AThCZFXMpe0xwZ': 'Starter',
  'price_1T3gqr0490AThCZFJxTNqvs6': 'Creator License',
  'price_1T3gqu0490AThCZF5tE4mu2d': 'Creator License (Activation)',
  'price_1T3gqx0490AThCZFe2kX0xWF': 'Agency',
  'price_1T3gr00490AThCZFKwMqWz6j': 'Agency (Activation)',
};

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const body = event.body;
  const sig = event.headers['stripe-signature'];

  // ─── VERIFY STRIPE SIGNATURE ───
  if (STRIPE_WEBHOOK_SECRET && sig) {
    try {
      verifySignature(body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Signature verification failed:', err.message);
      return { statusCode: 400, body: `Webhook Error: ${err.message}` };
    }
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // ─── PURCHASE COMPLETE ───
  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const customerEmail = session.customer_details?.email || session.customer_email || '';
    const customerName = session.customer_details?.name || 'Friend';
    const firstName = customerName.split(' ')[0];
    const amountPaid = ((session.amount_total || 0) / 100).toFixed(2);
    const currency = (session.currency || 'usd').toUpperCase();
    const priceId = session.metadata?.price_id || '';
    const planName = PLAN_NAMES[priceId] || session.metadata?.plan || 'Apps on Purpose';

    console.log(`[AOP] New sale: ${customerEmail} | ${planName} | $${amountPaid}`);

    await Promise.allSettled([
      customerEmail ? sendWelcomeEmail(customerEmail, firstName, planName) : Promise.resolve(),
      sendSaleNotification(customerEmail, customerName, planName, amountPaid, currency),
      GHL_WEBHOOK_URL ? fireGHL({
        eventType: 'purchase_completed',
        platform: 'apps-on-purpose',
        email: customerEmail,
        name: customerName,
        plan: planName,
        amount: amountPaid,
        currency,
        sessionId: session.id,
        timestamp: new Date().toISOString()
      }) : Promise.resolve()
    ]);
  }

  // ─── SUBSCRIPTION CANCELLED ───
  if (stripeEvent.type === 'customer.subscription.deleted') {
    const sub = stripeEvent.data.object;
    console.log(`[AOP] Subscription cancelled: ${sub.customer}`);
    if (GHL_WEBHOOK_URL) {
      await fireGHL({
        eventType: 'subscription_cancelled',
        platform: 'apps-on-purpose',
        stripeCustomerId: sub.customer,
        timestamp: new Date().toISOString()
      });
    }
  }

  // ─── PAYMENT FAILED ───
  if (stripeEvent.type === 'invoice.payment_failed') {
    const invoice = stripeEvent.data.object;
    const customerEmail = invoice.customer_email || '';
    console.log(`[AOP] Payment failed: ${customerEmail}`);
    if (customerEmail) {
      await resendPost({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: [customerEmail],
        subject: 'Action needed — payment issue with Apps on Purpose™',
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;background:#0E0A06;color:#FAF6F0;">
          <h2 style="color:#C9A96E;font-weight:300;">Payment Issue</h2>
          <p style="color:#D4C5B0;line-height:1.7;">We weren't able to process your latest payment for Apps on Purpose™. Your access remains active for now.</p>
          <p style="color:#D4C5B0;line-height:1.7;">Please update your payment method to keep your membership uninterrupted.</p>
          <a href="https://billing.stripe.com/p/login/test" style="display:inline-block;background:#C9A96E;color:#0E0A06;padding:14px 32px;text-decoration:none;font-weight:700;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;margin-top:16px;">Update Payment →</a>
          <p style="margin-top:32px;font-size:12px;color:rgba(250,246,240,0.3);">Questions? support@elvt.social</p>
        </div>`
      });
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

// ─── STRIPE SIGNATURE VERIFICATION ───
function verifySignature(payload, sigHeader, secret) {
  const parts = sigHeader.split(',');
  const tPart = parts.find(p => p.startsWith('t='));
  const v1Part = parts.find(p => p.startsWith('v1='));
  if (!tPart || !v1Part) throw new Error('Missing signature parts');

  const timestamp = tPart.slice(2);
  const signature = v1Part.slice(3);
  const signedPayload = `${timestamp}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  if (expected !== signature) throw new Error('Signature mismatch');

  // Check timestamp is within 5 minutes
  const diff = Math.abs(Date.now() / 1000 - parseInt(timestamp));
  if (diff > 300) throw new Error('Timestamp too old');
}

// ─── WELCOME EMAIL ───
async function sendWelcomeEmail(to, firstName, planName) {
  const isCreator = planName.includes('Creator');
  const isAgency = planName.includes('Agency');

  const bonusBlock = isCreator
    ? `<div style="background:#1A1208;border-left:3px solid #C9A96E;padding:20px 24px;margin:24px 0;">
        <p style="margin:0 0 6px;font-size:11px;color:#C9A96E;letter-spacing:0.15em;text-transform:uppercase;">Creator License Active ✦</p>
        <p style="margin:0;font-size:14px;color:#D4C5B0;line-height:1.7;">You can now sell Apps on Purpose™ as your own product and keep 100% of your sales. Your branded storefront is ready at contenthub.elvt.social.</p>
      </div>`
    : isAgency
    ? `<div style="background:#1A1208;border-left:3px solid #C9A96E;padding:20px 24px;margin:24px 0;">
        <p style="margin:0 0 6px;font-size:11px;color:#C9A96E;letter-spacing:0.15em;text-transform:uppercase;">Agency Access Active ✦</p>
        <p style="margin:0;font-size:14px;color:#D4C5B0;line-height:1.7;">Your onboarding call will be scheduled within 24 hours. You have 3 team seats and 10 client storefronts ready to configure.</p>
      </div>`
    : '';

  return resendPost({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: [to],
    subject: `Welcome to Apps on Purpose™ — You're in, ${firstName} ✦`,
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0E0A06;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:580px;margin:0 auto;padding:48px 20px;">
  <div style="text-align:center;margin-bottom:40px;">
    <p style="font-size:10px;letter-spacing:0.28em;text-transform:uppercase;color:#C9A96E;margin:0 0 10px;">ELVT Social</p>
    <h1 style="font-size:32px;font-weight:300;color:#FAF6F0;margin:0;">Apps <em style="color:#C9A96E;font-style:italic;">on Purpose</em>™</h1>
  </div>
  <div style="background:#150F08;border:1px solid rgba(201,169,110,0.15);padding:40px;">
    <p style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#C9A96E;margin:0 0 20px;">Welcome, ${firstName} ✦</p>
    <p style="font-size:20px;font-weight:300;color:#FAF6F0;line-height:1.5;margin:0 0 16px;">You're officially in.</p>
    <p style="font-size:14px;color:#D4C5B0;line-height:1.8;margin:0 0 28px;">Your <strong style="color:#FAF6F0;">${planName}</strong> membership is active. Here's your 3-step launch plan:</p>

    <div style="margin-bottom:28px;">
      <div style="display:flex;margin-bottom:16px;">
        <div style="min-width:34px;height:34px;background:#C9A96E;color:#0E0A06;font-weight:700;font-size:13px;text-align:center;line-height:34px;margin-right:16px;flex-shrink:0;">1</div>
        <div style="padding-top:4px;">
          <p style="margin:0 0 4px;font-size:14px;color:#FAF6F0;font-weight:500;">Open MakeMyApp GPT</p>
          <p style="margin:0;font-size:13px;color:#D4C5B0;line-height:1.6;">Answer 5 questions about your audience → complete app concept in 2 minutes.</p>
        </div>
      </div>
      <div style="display:flex;margin-bottom:16px;">
        <div style="min-width:34px;height:34px;background:#C9A96E;color:#0E0A06;font-weight:700;font-size:13px;text-align:center;line-height:34px;margin-right:16px;flex-shrink:0;">2</div>
        <div style="padding-top:4px;">
          <p style="margin:0 0 4px;font-size:14px;color:#FAF6F0;font-weight:500;">Build your 5-screen app in Canva</p>
          <p style="margin:0;font-size:13px;color:#D4C5B0;line-height:1.6;">Use GPT-generated copy + templates. Most members launch in under 60 minutes.</p>
        </div>
      </div>
      <div style="display:flex;">
        <div style="min-width:34px;height:34px;background:#C9A96E;color:#0E0A06;font-weight:700;font-size:13px;text-align:center;line-height:34px;margin-right:16px;flex-shrink:0;">3</div>
        <div style="padding-top:4px;">
          <p style="margin:0 0 4px;font-size:14px;color:#FAF6F0;font-weight:500;">Share your affiliate link & earn</p>
          <p style="margin:0;font-size:13px;color:#D4C5B0;line-height:1.6;">50% recurring commission — $48.50/month per referral, no cap, no end date.</p>
        </div>
      </div>
    </div>

    ${bonusBlock}

    <div style="text-align:center;margin:32px 0 24px;">
      <a href="https://aopnow.netlify.app" style="display:inline-block;background:#C9A96E;color:#0E0A06;padding:16px 40px;text-decoration:none;font-weight:700;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;">Access Your Dashboard →</a>
    </div>
    <p style="font-size:13px;color:#D4C5B0;line-height:1.8;margin:0;">Questions? <a href="mailto:support@elvt.social" style="color:#C9A96E;text-decoration:none;">support@elvt.social</a> — weekdays 9AM–6PM EST.</p>
  </div>
  <div style="text-align:center;margin-top:28px;">
    <p style="font-size:11px;color:rgba(250,246,240,0.25);margin:0;">ELVT Social — High Ticket Purpose &nbsp;·&nbsp; © 2026 &nbsp;·&nbsp; <a href="https://aopnow.netlify.app" style="color:rgba(201,169,110,0.4);text-decoration:none;">aopnow.netlify.app</a></p>
  </div>
</div>
</body></html>`
  });
}

// ─── SALE NOTIFICATION ───
async function sendSaleNotification(email, name, plan, amount, currency) {
  return resendPost({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: [NOTIFY_EMAIL],
    subject: `[AOP] ✦ New Sale — ${plan} $${amount} ${currency}`,
    html: `<div style="font-family:sans-serif;padding:32px;background:#0E0A06;color:#FAF6F0;max-width:480px;">
      <h2 style="color:#C9A96E;font-weight:300;font-size:22px;margin:0 0 24px;">New Sale ✦</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr style="border-bottom:1px solid rgba(201,169,110,0.1)"><td style="padding:10px 0;color:rgba(250,246,240,0.45);width:100px;">Name</td><td style="padding:10px 0;">${name}</td></tr>
        <tr style="border-bottom:1px solid rgba(201,169,110,0.1)"><td style="padding:10px 0;color:rgba(250,246,240,0.45);">Email</td><td style="padding:10px 0;">${email}</td></tr>
        <tr style="border-bottom:1px solid rgba(201,169,110,0.1)"><td style="padding:10px 0;color:rgba(250,246,240,0.45);">Plan</td><td style="padding:10px 0;">${plan}</td></tr>
        <tr style="border-bottom:1px solid rgba(201,169,110,0.1)"><td style="padding:10px 0;color:rgba(250,246,240,0.45);">Amount</td><td style="padding:10px 0;color:#C9A96E;font-weight:700;font-size:18px;">$${amount} ${currency}</td></tr>
        <tr><td style="padding:10px 0;color:rgba(250,246,240,0.45);">Time</td><td style="padding:10px 0;">${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})} EST</td></tr>
      </table>
      <p style="margin-top:24px;font-size:12px;color:rgba(250,246,240,0.3);">Apps on Purpose™ by ELVT Social</p>
    </div>`
  });
}

// ─── RESEND ───
function resendPost(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else reject(new Error(`Resend ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── GHL ───
function fireGHL(payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const url = new URL(GHL_WEBHOOK_URL);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}
