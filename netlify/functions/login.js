// ═══════════════════════════════════════════════════════════
// APPS ON PURPOSE — LOGIN
// Authenticates customer with email + password via Supabase
// ═══════════════════════════════════════════════════════════

const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  const { email, password } = body;

  if (!email || !password) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email and password required' }) };
  }

  try {
    const result = await supabaseLogin(email, password);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        access_token: result.access_token,
        user: {
          email: result.user?.email,
          id: result.user?.id,
          plan: result.user?.user_metadata?.plan || 'Starter'
        }
      })
    };
  } catch (err) {
    console.error('Login error:', err.message);
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Invalid email or password' })
    };
  }
};

function supabaseLogin(email, password) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + '/auth/v1/token?grant_type=password');
    const payload = JSON.stringify({ email, password });

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error_description || parsed.message || 'Login failed'));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error('Auth server error'));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
