// Shared utilities for the email-app services (compose, author-agent, send-agent).
// Only standard library is used to avoid external dependencies.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Parse LLM configuration from environment (global env plus optional overrides), model-agnostic (ollama or openai).
function getLLMConfigFromEnv(overrides = {}) {
  const provider = (overrides.LLM_PROVIDER || process.env.LLM_PROVIDER || 'ollama').toLowerCase();
  const model = overrides.LLM_MODEL || process.env.LLM_MODEL || '';
  const endpoint = overrides.LLM_ENDPOINT || process.env.LLM_ENDPOINT || '';
  let options = {};
  const optRaw = overrides.LLM_OPTIONS || process.env.LLM_OPTIONS;
  if (optRaw) {
    try { options = JSON.parse(optRaw); } catch (_) { options = {}; }
  }
  const apiKey = overrides.OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
  return { provider, model, endpoint, options, apiKey };
}

// Parse mail provider configuration (resend or gmail).
function getMailConfigFromEnv(overrides = {}) {
  const provider = (overrides.MAIL_PROVIDER || process.env.MAIL_PROVIDER || 'resend').toLowerCase();
  return {
    provider,
    resendApiKey: overrides.RESEND_API_KEY || process.env.RESEND_API_KEY || '',
    gmailClientId: overrides.GMAIL_CLIENT_ID || process.env.GMAIL_CLIENT_ID || '',
    gmailClientSecret: overrides.GMAIL_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET || '',
    gmailRefreshToken: overrides.GMAIL_REFRESH_TOKEN || process.env.GMAIL_REFRESH_TOKEN || '',
    gmailRedirectUri:
      overrides.GMAIL_REDIRECT_URI ||
      process.env.GMAIL_REDIRECT_URI ||
      'https://developers.google.com/oauthplayground'
  };
}

// Resolve the instance root from env; default to ./agents under cwd for safety.
function getInstanceRoot() {
  const root = process.env.INSTANCE_ROOT || path.join(process.cwd(), 'agents');
  return root;
}

// Build common paths for an instance.
function getInstancePaths(instanceId) {
  if (!instanceId) throw new Error('instance_id is required');
  const root = path.join(getInstanceRoot(), 'email-app', instanceId);
  return {
    root,
    meta: path.join(root, 'meta.json'),
    config: path.join(root, 'config.json'),
    traces: path.join(root, 'llm_traces.json'),
    artifactsDir: path.join(root, 'artifacts'),
    draftHtml: path.join(root, 'artifacts', 'email.html'),
    logsDir: path.join(root, 'logs'),
    runLog: path.join(root, 'logs', 'run.log')
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function appendLocalLog(instanceId, service, message) {
  try {
    const { logsDir } = getInstancePaths(instanceId);
    ensureDir(logsDir);
    const file = path.join(logsDir, `${service}.log`);
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(file, line, 'utf8');
  } catch (_) {
    // Fail open; local logging should not crash the service
  }
}

function parseEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    const out = {};
    for (const line of lines) {
      if (!line || line.trim().startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (key) out[key] = val;
    }
    return out;
  } catch (_) {
    return {};
  }
}

function loadInstanceEnv(instanceId) {
  const { root } = getInstancePaths(instanceId);
  const envPath = path.join(root, '.env');
  return parseEnvFile(envPath);
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function writeJsonSafe(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function loadInstanceConfig(instanceId) {
  const { config } = getInstancePaths(instanceId);
  return readJsonSafe(config) || {};
}

function appendLlmTrace(instanceId, entry) {
  const { traces } = getInstancePaths(instanceId);
  ensureDir(path.dirname(traces));
  let records = [];
  try {
    if (fs.existsSync(traces)) {
      records = JSON.parse(fs.readFileSync(traces, 'utf8'));
      if (!Array.isArray(records)) records = [];
    }
  } catch (_) {
    records = [];
  }
  records.push(entry);
  fs.writeFileSync(traces, JSON.stringify(records, null, 2), 'utf8');
}

// Logging client - fail open on errors.
async function logEvent({ service, level = 'info', event_type, message, instance_id, username, trace_id }) {
  const url = process.env.LOG_API_URL || 'http://localhost:4000/api/log';
  const ts = new Date().toISOString();
  const payload = { service, level, event_type, message, instance_id, username, trace_id, ts };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[logEvent] failed ${res.status}: ${text}`);
    }
  } catch (e) {
    console.error('[logEvent] error sending log', e.message || e);
  }
}

function generateInstanceId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function validateInstanceId(value) {
  return typeof value === 'string' && !!value.trim();
}

function updateMeta(instanceId, updater) {
  const { meta } = getInstancePaths(instanceId);
  const existing = readJsonSafe(meta) || {};
  const next = typeof updater === 'function' ? updater({ ...existing }) : { ...existing, ...(updater || {}) };
  writeJsonSafe(meta, next);
  return next;
}

module.exports = {
  getInstanceRoot,
  getInstancePaths,
  ensureDir,
  readJsonSafe,
  writeJsonSafe,
  loadInstanceConfig,
  appendLlmTrace,
  appendLocalLog,
  updateMeta,
  logEvent,
  generateInstanceId,
  validateInstanceId,
  loadInstanceEnv,
  getLLMConfigFromEnv,
  getMailConfigFromEnv
};
