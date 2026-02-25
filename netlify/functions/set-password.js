// ═══════════════════════════════════════════════════════════
// APPS ON PURPOSE — SET PASSWORD
// Called when customer clicks link in welcome email and sets password
// ═══════════════════════════════════════════════════════════

const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

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
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { token, password } = body;

  if (!token || !password) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Token and password required' }) };
  }

  if (password.length < 8) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Password must be at least 8 characters' }) };
  }

  try {
    // Verify the invite token and set the password via Supabase Admin API
    const result = await supabaseRequest('PUT', '/auth/v1/admin/users', null, {
      // We use the token to find the user, then update their password
    });

    // Actually use the user token exchange endpoint
    const exchangeResult = await supabaseRequest('POST', '/auth/v1/user', token, {
      password: password
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: 'Password set successfully' })
    };
  } catch (err) {
    console.error('Set password error:', err);
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: err.message || 'Failed to set password' })
    };
  }
};

function supabaseRequest(method, path, authToken, data) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + path);
    const payload = JSON.stringify(data);

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': authToken ? `Bearer ${authToken}` : `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseData);
          if (res.statusCode >= 400) {
            reject(new Error(parsed.message || parsed.error_description || 'Supabase error'));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error('Invalid response from auth server'));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
