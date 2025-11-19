// send-agent: sends approved HTML emails to recipients (mailer stub).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');
const {
  getInstancePaths,
  ensureDir,
  appendLocalLog,
  logEvent,
  validateInstanceId,
  getMailConfigFromEnv,
  loadInstanceEnv
} = require('../shared');

const PORT = Number(process.env.SEND_PORT || process.env.EMAIL_PORT || process.env.PORT || 4102);
const SERVICE = 'send-agent';
const RESEND_API = 'https://api.resend.com/emails';
const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

async function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function requireRecipients(to, cc, bcc) {
  const toArr = Array.isArray(to) ? to.filter(Boolean) : [];
  const ccArr = Array.isArray(cc) ? cc.filter(Boolean) : [];
  const bccArr = Array.isArray(bcc) ? bcc.filter(Boolean) : [];
  if (!toArr.length && !ccArr.length && !bccArr.length) return null;
  return { to: toArr, cc: ccArr, bcc: bccArr };
}

async function sendViaResend({ apiKey, fromEmail, fromName, to, cc, bcc, subject, html }) {
  if (!apiKey) throw new Error('resend_api_key_missing');
  const payload = {
    from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
    to,
    subject,
    html
  };
  if (cc && cc.length) payload.cc = cc;
  if (bcc && bcc.length) payload.bcc = bcc;
  const res = await fetch(RESEND_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`resend_error_${res.status}: ${text}`);
  }
  const data = await res.json();
  return { id: data.id || data.message || `resend-${Date.now()}` };
}

async function getGmailAccessToken(cfg) {
  const { gmailClientId, gmailClientSecret, gmailRefreshToken, gmailRedirectUri } = cfg;
  if (!gmailClientId || !gmailClientSecret || !gmailRefreshToken) {
    throw new Error('gmail_credentials_missing');
  }
  const res = await fetch(GMAIL_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: gmailClientId,
      client_secret: gmailClientSecret,
      refresh_token: gmailRefreshToken,
      grant_type: 'refresh_token',
      redirect_uri: gmailRedirectUri || 'https://developers.google.com/oauthplayground'
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`gmail_token_error_${res.status}: ${text}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('gmail_access_token_missing');
  return data.access_token;
}

function buildGmailRaw({ fromEmail, to, cc, bcc, subject, html }) {
  const headers = [];
  headers.push(`From: ${fromEmail}`);
  headers.push(`To: ${to.join(', ')}`);
  if (cc && cc.length) headers.push(`Cc: ${cc.join(', ')}`);
  if (bcc && bcc.length) headers.push(`Bcc: ${bcc.join(', ')}`);
  headers.push(`Subject: ${subject}`);
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/html; charset="UTF-8"');
  const message = headers.join('\r\n') + '\r\n\r\n' + html;
  return Buffer.from(message).toString('base64');
}

async function sendViaGmail({ cfg, fromEmail, to, cc, bcc, subject, html }) {
  const accessToken = await getGmailAccessToken(cfg);
  const raw = buildGmailRaw({ fromEmail, to, cc, bcc, subject, html });
  const res = await fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`gmail_send_error_${res.status}: ${text}`);
  }
  const data = await res.json();
  return { id: data.id || `gmail-${Date.now()}` };
}

async function sendEmailProvider({ mailCfg, fromEmail, fromName, to, cc, bcc, subject, html }) {
  const provider = (mailCfg.provider || 'resend').toLowerCase();
  if (provider === 'gmail') {
    return sendViaGmail({
      cfg: mailCfg,
      fromEmail,
      to,
      cc,
      bcc,
      subject,
      html
    });
  }
  // Default to Resend
  return sendViaResend({
    apiKey: mailCfg.resendApiKey,
    fromEmail,
    fromName,
    to,
    cc,
    bcc,
    subject,
    html
  });
}

async function handleSend(req, res) {
  let payload;
  try { payload = await parseJsonBody(req); }
  catch (_) { return sendJson(res, 400, { error: 'invalid_json' }); }

  const {
    instance_id,
    username,
    html,
    subject,
    sender_email,
    sender_name,
    to,
    cc,
    bcc,
    trace_id
  } = payload || {};

  if (!validateInstanceId(instance_id)) return sendJson(res, 400, { error: 'instance_id_required' });
  if (!username) return sendJson(res, 400, { error: 'username_required' });
  if (!html) return sendJson(res, 400, { error: 'html_required' });
  if (!subject) return sendJson(res, 400, { error: 'subject_required' });
  const recipients = requireRecipients(to, cc, bcc);
  if (!recipients) return sendJson(res, 400, { error: 'recipients_required' });

  // Load per-instance mail configuration overrides.
  const instanceEnv = loadInstanceEnv(instance_id);
  const mailCfg = getMailConfigFromEnv(instanceEnv);

  await logEvent({
    service: SERVICE,
    level: 'info',
    event_type: 'progress',
    message: `Sending email (${mailCfg.provider})`,
    instance_id,
    username,
    trace_id
  });

  const { artifactsDir, draftHtml } = getInstancePaths(instance_id);
  ensureDir(artifactsDir);
  fs.writeFileSync(draftHtml, html, 'utf8');
  appendLocalLog(instance_id, 'send-agent', 'Sending email via provider');

  let sendResult;
  try {
    sendResult = await sendEmailProvider({
      mailCfg,
      fromEmail: sender_email,
      fromName: sender_name,
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      subject,
      html
    });
  } catch (err) {
    return sendJson(res, 502, { error: err.message || String(err) });
  }
  const messageId = sendResult.id || `msg-${crypto.randomBytes(6).toString('hex')}`;
  const sentAt = new Date().toISOString();

  await logEvent({
    service: SERVICE,
    level: 'info',
    event_type: 'state_change',
    message: `Email sent (${mailCfg.provider})`,
    instance_id,
    username,
    trace_id
  });

  return sendJson(res, 200, { id: messageId, sent_at: sentAt, status: 'sent', trace_id: trace_id || null });
}

function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true });
  if (req.method === 'POST' && url.pathname === '/send') return handleSend(req, res);
  return sendJson(res, 404, { error: 'not_found' });
}

http.createServer(router).listen(PORT, () => {
  console.log(`[send-agent] listening on ${PORT}`);
});
