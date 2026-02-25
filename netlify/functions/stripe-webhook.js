// ═══════════════════════════════════════════════════════════
// APPS ON PURPOSE — STRIPE WEBHOOK
// Magic Link Auth via Supabase — no passwords, ever
// ═══════════════════════════════════════════════════════════

const https = require('https');
const crypto = require('crypto');

const RESEND_API_KEY       = process.env.RESEND_API_KEY;
const STRIPE_WEBHOOK_SECRET= process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GHL_WEBHOOK_URL      = process.env.GHL_WEBHOOK_URL || '';
const FROM_EMAIL           = process.env.FROM_EMAIL || 're@elvt.social';
const FROM_NAME            = process.env.FROM_NAME  || 'ELVT Social — Apps on Purpose';
const NOTIFY_EMAIL         = process.env.NOTIFY_EMAIL || 'kendryah@highticketpurpose.com';
const SITE_URL             = 'https://app.elvtsocial.xyz';

const PLAN_NAMES = {
  'price_1T3gqo0490AThCZFXMpe0xwZ': 'Starter',
  'price_1T3gqr0490AThCZFJxTNqvs6': 'Creator License',
  'price_1T3gqu0490AThCZF5tE4mu2d': 'Creator License (Activation)',
  'price_1T3gqx0490AThCZFe2kX0xWF': 'Agency',
  'price_1T3gr00490AThCZFKwMqWz6j': 'Agency (Activation)',
};

// ─── MAIN HANDLER ────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const body = event.body;
  const sig  = event.headers['stripe-signature'];

  if (STRIPE_WEBHOOK_SECRET && sig) {
    try { verifySignature(body, sig, STRIPE_WEBHOOK_SECRET); }
    catch (err) { return { statusCode: 400, body: `Webhook Error: ${err.message}` }; }
  }

  let stripeEvent;
  try { stripeEvent = JSON.parse(body); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  // ─── PURCHASE COMPLETE ───────────────────────────────────
  if (stripeEvent.type === 'checkout.session.completed') {
    const session       = stripeEvent.data.object;
    const customerEmail = session.customer_details?.email || session.customer_email || '';
    const customerName  = session.customer_details?.name  || 'Friend';
    const firstName     = customerName.split(' ')[0];
    const amountPaid    = ((session.amount_total || 0) / 100).toFixed(2);
    const currency      = (session.currency || 'usd').toUpperCase();
    const priceId       = session.metadata?.price_id || '';
    const planName      = PLAN_NAMES[priceId] || session.metadata?.plan || 'Starter';

    console.log(`[AOP] New sale: ${customerEmail} | ${planName} | $${amountPaid}`);

    // Generate magic link via Supabase
    let magicLink = `${SITE_URL}/dashboard`;
    if (customerEmail && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      try {
        // 1. Create or find user in Supabase (upsert style — won't error if exists)
        try {
          await supabaseRequest('POST', '/auth/v1/admin/users', {
            email: customerEmail,
            email_confirm: true,
            user_metadata: { full_name: customerName, plan: planName, purchased_at: new Date().toISOString() }
          });
          console.log(`[AOP] Supabase user created: ${customerEmail}`);
        } catch (createErr) {
          // User likely already exists — that's fine, continue to magic link
          console.log(`[AOP] User exists or create failed: ${createErr.message}`);
        }

        // 2. Generate magic link (OTP login link — no password required)
        const linkData = await supabaseRequest('POST', '/auth/v1/admin/generate_link', {
          type: 'magiclink',
          email: customerEmail,
          redirect_to: `${SITE_URL}/dashboard`
        });

        if (linkData?.action_link) {
          magicLink = linkData.action_link;
          console.log(`[AOP] Magic link generated for ${customerEmail}`);
        }
      } catch (err) {
        console.error('[AOP] Supabase magic link error:', err.message);
        // Fallback: send them to dashboard directly (no auth gate yet)
        magicLink = `${SITE_URL}/dashboard`;
      }
    }

    await Promise.allSettled([
      customerEmail ? sendWelcomeEmail(customerEmail, firstName, planName, magicLink) : Promise.resolve(),
      sendSaleNotification(customerEmail, customerName, planName, amountPaid, currency),
      GHL_WEBHOOK_URL ? fireGHL({
        eventType: 'purchase_completed',
        platform: 'apps-on-purpose',
        email: customerEmail,
        name: customerName,
        plan: planName,
        amount: amountPaid,
        currency,
        timestamp: new Date().toISOString()
      }) : Promise.resolve()
    ]);
  }

  // ─── SUBSCRIPTION CANCELLED ──────────────────────────────
  if (stripeEvent.type === 'customer.subscription.deleted') {
    const sub = stripeEvent.data.object;
    if (GHL_WEBHOOK_URL) await fireGHL({
      eventType: 'subscription_cancelled',
      platform: 'apps-on-purpose',
      stripeCustomerId: sub.customer,
      timestamp: new Date().toISOString()
    });
  }

  // ─── PAYMENT FAILED ──────────────────────────────────────
  if (stripeEvent.type === 'invoice.payment_failed') {
    const invoice = stripeEvent.data.object;
    const customerEmail = invoice.customer_email || '';
    if (customerEmail) {
      await resendPost({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: [customerEmail],
        subject: 'Action needed — payment issue with Apps on Purpose™',
        html: `<div style="font-family:sans-serif;max-width:560px;padding:40px;background:#0E0A06;color:#FAF6F0;">
          <h2 style="color:#C9A96E;font-weight:300;margin:0 0 16px;">Payment Issue</h2>
          <p style="color:#D4C5B0;line-height:1.7;margin:0 0 24px;">We weren't able to process your latest payment for Apps on Purpose™. Your access remains active for now — please update your payment method to avoid interruption.</p>
          <a href="https://billing.stripe.com/p/login/aEUg2v0XIdoRfgk3cc" style="display:inline-block;background:#C9A96E;color:#0E0A06;padding:14px 32px;text-decoration:none;font-weight:700;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;">Update Payment Method →</a>
          <p style="margin-top:32px;font-size:12px;color:rgba(250,246,240,0.3);">Questions? <a href="mailto:support@elvt.social" style="color:#C9A96E;text-decoration:none;">support@elvt.social</a></p>
        </div>`
      });
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

// ─── SEND WELCOME EMAIL WITH MAGIC LINK ──────────────────────
async function sendWelcomeEmail(to, firstName, planName, magicLink) {
  const isCreator = planName.includes('Creator');
  const isAgency  = planName.includes('Agency');

  const bonusBlock = isCreator
    ? `<div style="background:#1A1208;border-left:3px solid #C9A96E;padding:20px 24px;margin:24px 0;">
        <p style="margin:0 0 6px;font-size:11px;color:#C9A96E;letter-spacing:0.15em;text-transform:uppercase;">Creator License Active ✦</p>
        <p style="margin:0;font-size:14px;color:#D4C5B0;line-height:1.7;">You can now sell Apps on Purpose™ as your own product and keep 100% of sales.</p>
       </div>`
    : isAgency
    ? `<div style="background:#1A1208;border-left:3px solid #C9A96E;padding:20px 24px;margin:24px 0;">
        <p style="margin:0 0 6px;font-size:11px;color:#C9A96E;letter-spacing:0.15em;text-transform:uppercase;">Agency Access Active ✦</p>
        <p style="margin:0;font-size:14px;color:#D4C5B0;line-height:1.7;">Your onboarding call will be scheduled within 24 hours.</p>
       </div>`
    : '';

  return resendPost({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: [to],
    subject: `You're in, ${firstName} — access your Apps on Purpose™ dashboard ✦`,
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0E0A06;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:580px;margin:0 auto;padding:48px 20px;">

  <div style="text-align:center;margin-bottom:40px;">
    <p style="font-size:10px;letter-spacing:0.28em;text-transform:uppercase;color:#C9A96E;margin:0 0 10px;">ELVT Social</p>
    <h1 style="font-size:32px;font-weight:300;color:#FAF6F0;margin:0;">Apps <em style="color:#C9A96E;font-style:italic;">on Purpose</em>™</h1>
  </div>

  <div style="background:#150F08;border:1px solid rgba(201,169,110,0.15);padding:40px;">
    <p style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#C9A96E;margin:0 0 16px;">Welcome, ${firstName} ✦</p>
    <p style="font-size:20px;font-weight:300;color:#FAF6F0;line-height:1.5;margin:0 0 16px;">Your <strong>${planName}</strong> membership is active.</p>
    <p style="font-size:15px;color:#D4C5B0;line-height:1.8;margin:0 0 8px;">Click the button below to access your dashboard — <strong style="color:#FAF6F0;">no password required.</strong></p>
    <p style="font-size:13px;color:rgba(212,197,176,0.5);margin:0 0 32px;">One click and you're in.</p>

    <div style="text-align:center;margin:0 0 32px;">
      <a href="${magicLink}" style="display:inline-block;background:#C9A96E;color:#0E0A06;padding:18px 48px;text-decoration:none;font-weight:700;font-size:12px;letter-spacing:0.22em;text-transform:uppercase;">Access My Dashboard →</a>
      <p style="font-size:12px;color:rgba(250,246,240,0.3);margin:12px 0 0;">This link expires in 24 hours · Good for one use</p>
    </div>

    <div style="border-top:1px solid rgba(201,169,110,0.1);padding-top:24px;margin-bottom:0;">
      <p style="font-size:12px;color:rgba(212,197,176,0.5);margin:0 0 12px;text-transform:uppercase;letter-spacing:0.15em;">What's waiting for you</p>
      <p style="font-size:13px;color:#D4C5B0;margin:0 0 8px;">✦ &nbsp;7 course modules — build your first app today</p>
      <p style="font-size:13px;color:#D4C5B0;margin:0 0 8px;">✦ &nbsp;MakeMyApp GPT — your app concept in 2 minutes</p>
      <p style="font-size:13px;color:#D4C5B0;margin:0 0 8px;">✦ &nbsp;50% recurring affiliate commissions</p>
      <p style="font-size:13px;color:#D4C5B0;margin:0;">✦ &nbsp;Private community access</p>
    </div>

    ${bonusBlock}

    <p style="font-size:13px;color:#D4C5B0;line-height:1.8;margin:24px 0 0;">
      Need a new login link later? Just email <a href="mailto:support@elvt.social" style="color:#C9A96E;text-decoration:none;">support@elvt.social</a> and we'll send one within minutes.
    </p>
  </div>

  <p style="font-size:11px;color:rgba(250,246,240,0.25);text-align:center;margin-top:28px;">
    ELVT Social · Apps on Purpose™ © 2026 · <a href="${SITE_URL}" style="color:rgba(201,169,110,0.4);text-decoration:none;">app.elvtsocial.xyz</a>
  </p>
</div>
</body></html>`
  });
}

// ─── SALE NOTIFICATION ───────────────────────────────────────
async function sendSaleNotification(email, name, plan, amount, currency) {
  return resendPost({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: [NOTIFY_EMAIL],
    subject: `[AOP] ✦ New Sale — ${plan} $${amount} ${currency}`,
    html: `<div style="font-family:sans-serif;padding:32px;background:#0E0A06;color:#FAF6F0;max-width:480px;">
      <h2 style="color:#C9A96E;font-weight:300;font-size:22px;margin:0 0 24px;">New Sale ✦</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr style="border-bottom:1px solid rgba(201,169,110,0.1)"><td style="padding:10px 0;color:rgba(250,246,240,0.45);width:100px;">Name</td><td>${name}</td></tr>
        <tr style="border-bottom:1px solid rgba(201,169,110,0.1)"><td style="padding:10px 0;color:rgba(250,246,240,0.45);">Email</td><td>${email}</td></tr>
        <tr style="border-bottom:1px solid rgba(201,169,110,0.1)"><td style="padding:10px 0;color:rgba(250,246,240,0.45);">Plan</td><td>${plan}</td></tr>
        <tr style="border-bottom:1px solid rgba(201,169,110,0.1)"><td style="padding:10px 0;color:rgba(250,246,240,0.45);">Amount</td><td style="color:#C9A96E;font-weight:700;font-size:18px;">$${amount} ${currency}</td></tr>
        <tr><td style="padding:10px 0;color:rgba(250,246,240,0.45);">Time</td><td>${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})} EST</td></tr>
      </table>
      <p style="margin-top:24px;font-size:12px;color:rgba(250,246,240,0.3);">Apps on Purpose™ by ELVT Social</p>
    </div>`
  });
}

// ─── HELPERS ─────────────────────────────────────────────────
function supabaseRequest(method, path, data) {
  return new Promise((resolve, reject) => {
    const url     = new URL(SUPABASE_URL + path);
    const payload = JSON.stringify(data);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (res.statusCode >= 400) reject(new Error(parsed.message || parsed.error_description || JSON.stringify(parsed)));
          else resolve(parsed);
        } catch { reject(new Error('Invalid Supabase response')); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function verifySignature(payload, sigHeader, secret) {
  const parts   = sigHeader.split(',');
  const tPart   = parts.find(p => p.startsWith('t='));
  const v1Part  = parts.find(p => p.startsWith('v1='));
  if (!tPart || !v1Part) throw new Error('Missing signature parts');
  const timestamp = tPart.slice(2);
  const signature = v1Part.slice(3);
  const expected  = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  if (expected !== signature) throw new Error('Signature mismatch');
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) throw new Error('Timestamp too old');
}

function resendPost(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req  = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Length': Buffer.byteLength(body) }
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

function fireGHL(payload) {
  return new Promise(resolve => {
    const body = JSON.stringify(payload);
    const url  = new URL(GHL_WEBHOOK_URL);
    const req  = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}
