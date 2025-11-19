// compose orchestrator: calls author-agent then email-agent.
const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');
const fs = require('fs');
const {
  getInstancePaths,
  ensureDir,
  loadInstanceConfig,
  readJsonSafe,
  writeJsonSafe,
  logEvent,
  generateInstanceId,
  validateInstanceId,
  appendLocalLog,
  updateMeta
} = require('../shared');

const PORT = Number(process.env.PORT || 4100);
const SERVICE = 'compose';
const AUTHOR_URL = process.env.AUTHOR_AGENT_URL || 'http://127.0.0.1:4101';
const EMAIL_URL = process.env.EMAIL_AGENT_URL || 'http://127.0.0.1:4102';
const HITL_URL = process.env.HITL_API_URL || 'http://127.0.0.1:3001/api/hitl-agent';

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

function mergeConfig(instanceId, payload) {
  const cfg = loadInstanceConfig(instanceId);
  const subject = payload.subject || cfg.subject || cfg.EMAIL_SUBJECT || null;
  const to = payload.to || cfg.to || [];
  const cc = payload.cc || cfg.cc || [];
  const bcc = payload.bcc || cfg.bcc || [];
  const sender_email = payload.sender_email || cfg.sender_email || cfg.SENDER_EMAIL || null;
  const sender_name = payload.sender_name || cfg.sender_name || cfg.SENDER_NAME || null;
  return { subject, to, cc, bcc, sender_email, sender_name };
}

function markInstanceActive(instanceId, username) {
  updateMeta(instanceId, (prev) => {
    const next = { ...(prev || {}), status: 'active' };
    if (!next.started_at) {
      next.started_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
    }
    if (username && !next.owner) next.owner = username;
    return next;
  });
  try {
    appendLocalLog(instanceId, 'compose', 'state - active');
  } catch (_) { /* ignore */ }
}

function requireRecipients(to, cc, bcc) {
  const toArr = Array.isArray(to) ? to.filter(Boolean) : [];
  const ccArr = Array.isArray(cc) ? cc.filter(Boolean) : [];
  const bccArr = Array.isArray(bcc) ? bcc.filter(Boolean) : [];
  if (!toArr.length && !ccArr.length && !bccArr.length) return null;
  return { to: toArr, cc: ccArr, bcc: bccArr };
}

async function callAuthorAgent(body) {
  const res = await fetch(`${AUTHOR_URL}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`author_agent_error_${res.status}: ${text}`);
  }
  return res.json();
}

async function callEmailAgent(body) {
  const res = await fetch(`${EMAIL_URL}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`email_agent_error_${res.status}: ${text}`);
  }
  return res.json();
}

async function callHitlAgent({ instance_id, html, hitlConfig, loopIndex = 0, trace_id }) {
  const payload = {
    caller_id: instance_id,
    html,
    hitl: hitlConfig || {},
    loop: loopIndex + 1
  };
  appendLocalLog(instance_id, 'compose', `HITL submit -> ${HITL_URL}`);
  const res = await fetch(HITL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }
  return { status: res.status, body };
}

async function submitHitlAndHandle({
  instanceId,
  username,
  html,
  hitlConfig,
  loopIndex = 0,
  traceId,
  abortOnFail = true
}) {
  const hitlResp = await callHitlAgent({
    instance_id: instanceId,
    username,
    html,
    hitlConfig,
    loopIndex,
    trace_id: traceId
  });
  const statusCode = hitlResp.status;
  const hitlError = hitlResp.body && hitlResp.body.error ? hitlResp.body.error : null;
  const hitlStatus = hitlResp.body && hitlResp.body.status ? hitlResp.body.status : null;
  const hitlInfo = hitlResp.body && (hitlResp.body.information || hitlResp.body.info) ? (hitlResp.body.information || hitlResp.body.info) : null;
  const hitlAccepted = (statusCode === 200 || statusCode === 202) && !hitlError && hitlStatus !== 'no-hitl' && hitlStatus !== 'skip';

  if (!hitlAccepted && abortOnFail) {
    const reason = `HITL submission rejected: status=${statusCode}${hitlError ? ` error=${hitlError}` : ''}${hitlStatus ? ` status=${hitlStatus}` : ''}${hitlInfo ? ` info=${hitlInfo}` : ''}`;
    try {
      appendLocalLog(instanceId, 'compose', reason);
    } catch (_) { /* ignore */ }
    await logEvent({
      service: SERVICE,
      level: 'warn',
      event_type: 'record',
      message: reason,
      instance_id: instanceId,
      username,
      trace_id: traceId
    });
    await abortInstance({
      instanceId,
      username,
      traceId,
      note: `HITL submission failed: ${statusCode}${hitlError ? ` error=${hitlError}` : ''}${hitlStatus ? ` status=${hitlStatus}` : ''}${hitlInfo ? ` info=${hitlInfo}` : ''}`
    });
  }

  if (hitlAccepted) {
    await logEvent({
      service: SERVICE,
      level: 'info',
      event_type: 'progress',
      message: `HITL submission accepted (${statusCode})`,
      instance_id: instanceId,
      username,
      trace_id: traceId
    });
    try {
      appendLocalLog(instanceId, 'compose', `HITL submission accepted (${statusCode})`);
    } catch (_) { /* ignore */ }
    // Transition to wait state while HITL is pending
    try {
      updateMeta(instanceId, { status: 'wait' });
      appendLocalLog(instanceId, 'compose', 'state - wait');
      await logEvent({
        service: SERVICE,
        level: 'info',
        event_type: 'state_change',
        message: 'state - wait',
        instance_id: instanceId,
        username,
        trace_id: traceId
      });
    } catch (_) { /* ignore */ }
  }

  return { accepted: hitlAccepted, status: statusCode, error: hitlError, hitlStatus, hitlInfo };
}

function readLatestEmailHtml(instanceId) {
  const { draftHtml } = getInstancePaths(instanceId);
  try {
    if (fs.existsSync(draftHtml)) {
      return fs.readFileSync(draftHtml, 'utf8');
    }
  } catch (_) {}
  return '';
}

function abortInstance({ instanceId, username, traceId, note }) {
  updateMeta(instanceId, {
    status: 'abort',
    finished_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
  });
  try {
    appendLocalLog(instanceId, 'compose', 'state - abort');
    if (note) appendLocalLog(instanceId, 'compose', note);
  } catch (_) { /* ignore */ }
  return logEvent({
    service: SERVICE,
    level: 'warn',
    event_type: 'state_change',
    message: note ? `state - abort (${note})` : 'state - abort',
    instance_id: instanceId,
    username: username || 'unknown',
    trace_id: traceId || crypto.randomBytes(6).toString('hex')
  });
}

async function handleAbort(req, res) {
  let body = {};
  try { body = await parseJsonBody(req); } catch (_) { return sendJson(res, 400, { error: 'invalid_json' }); }
  const { instance_id, username, trace_id } = body || {};
  if (!validateInstanceId(instance_id)) return sendJson(res, 400, { error: 'instance_id_required' });
  if (!username) return sendJson(res, 400, { error: 'username_required' });
  const traceId = trace_id || crypto.randomBytes(6).toString('hex');

  await abortInstance({ instanceId: instance_id, username, traceId });

  return sendJson(res, 200, { ok: true, instance_id, trace_id: traceId });
}

async function handleHitlCallback(req, res) {
  let body = {};
  try { body = await parseJsonBody(req); } catch (_) { return sendJson(res, 400, { error: 'invalid_json' }); }
  const { instance_id, result, response, information, instructions, username, trace_id, async: isAsync } = body || {};
  const action = (response || result || '').toString().toLowerCase();
  if (!validateInstanceId(instance_id)) return sendJson(res, 400, { error: 'instance_id_required' });
  const user = (username || '').trim() || 'unknown';
  const traceId = trace_id || crypto.randomBytes(6).toString('hex');

  const handler = async () => {
    const infoText = information ? ` info='${String(information)}'` : '';
    appendLocalLog(instance_id, 'compose', `hitl-callback: ${action || 'unknown'}${infoText}`);
    await logEvent({
      service: SERVICE,
      level: 'info',
      event_type: 'record',
      message: `hitl-callback: ${action || 'unknown'}${infoText}`,
      instance_id,
      username: user,
      trace_id: traceId
    });

    // Load config and recipients
    const merged = mergeConfig(instance_id, {});

    const finishAs = (status, logMsg) => {
      updateMeta(instance_id, {
        status,
        finished_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
      });
      appendLocalLog(instance_id, 'compose', `state - ${status}`);
      logEvent({
        service: SERVICE,
        level: status === 'finished' ? 'info' : 'warn',
        event_type: 'state_change',
        message: `state - ${status}${logMsg ? ` (${logMsg})` : ''}`,
        instance_id,
        username: user,
        trace_id: traceId
      });
    };

    if (action === 'approve') {
      // Send using existing email.html
      const html = readLatestEmailHtml(instance_id);
      try {
        await callEmailAgent({
          instance_id,
          username: user,
          html,
          subject: merged.subject,
          sender_email: merged.sender_email,
          sender_name: merged.sender_name,
          to: merged.to,
          cc: merged.cc,
          bcc: merged.bcc,
          trace_id: traceId
        });
        finishAs('finished', 'hitl approve');
        return;
      } catch (e) {
        finishAs('abort', `email send failed: ${e.message || e}`);
        throw new Error(e && e.message ? e.message : e);
      }
    }

    if (action === 'reject') {
      finishAs('abort', information ? String(information) : 'hitl reject');
      return;
    }

    if (action === 'modify') {
      const rawInstr = instructions || information || '';
      const newInstr = rawInstr && rawInstr.trim() ? `[Key Instruction] ${rawInstr.trim()}` : '';
      // Increment gen_count
      let nextGen = 1;
      updateMeta(instance_id, (prev) => {
        const next = { ...(prev || {}) };
        next.gen_count = parseInt(next.gen_count || 0, 10) + 1;
        nextGen = next.gen_count;
        next.status = 'active';
        return next;
      });
      const baseHtml = readLatestEmailHtml(instance_id);
      try {
        await logEvent({
          service: SERVICE,
          level: 'info',
          event_type: 'record',
          message: `Calling LLM to re-generate email (${nextGen})`,
          instance_id,
          username: user,
          trace_id: traceId
        });
        const authorResp = await callAuthorAgent({
          instance_id,
          username: user,
          instructions: newInstr,
          base_html: baseHtml,
          subject: merged.subject,
          trace_id: traceId
        });
        const cfg = loadInstanceConfig(instance_id) || {};
        const hitlCfg = cfg['human-in-the-loop'] || cfg['hitl'] || cfg['HITL'] || {};
        const hitlResult = await submitHitlAndHandle({
          instanceId: instance_id,
          username: user,
          html: authorResp.html,
          hitlConfig: hitlCfg,
          loopIndex: nextGen - 1,
          traceId,
          abortOnFail: false
        });
        if (!hitlResult.accepted) {
          const detail = hitlResult.error || hitlResult.hitlInfo || hitlResult.hitlStatus;
          await abortInstance({
            instanceId: instance_id,
            username: user,
            traceId,
            note: `HITL resubmit failed: ${hitlResult.status}${detail ? ` detail=${detail}` : ''}`
          });
          throw new Error(`HITL resubmit failed ${hitlResult.status}${detail ? ` detail=${detail}` : ''}`);
        }
        return;
      } catch (e) {
        finishAs('abort', `modify failed: ${e.message || e}`);
        throw e;
      }
    }

    throw new Error('unknown_hitl_result');
  };

  if (isAsync === true) {
    setImmediate(() => {
      handler().catch((e) => {
        try { appendLocalLog(instance_id, 'compose', `hitl-callback async error: ${e && e.message ? e.message : e}`); } catch (_) {}
      });
    });
    return sendJson(res, 202, { status: 'accepted', instance_id, trace_id: traceId });
  }

  try {
    await handler();
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    // handler already logged; return generic error
    return sendJson(res, 400, { error: 'hitl_callback_failed', detail: e && e.message ? e.message : e });
  }
}

async function handleComposeSend(req, res) {
  let payload;
  try { payload = await parseJsonBody(req); }
  catch (_) { return sendJson(res, 400, { error: 'invalid_json' }); }

  let { instance_id } = payload || {};
  const { username, instructions, regen_base_html: base_html = '', trace_id } = payload || {};
  if (!username) return sendJson(res, 400, { error: 'username_required' });
  if (!instructions && !base_html) return sendJson(res, 400, { error: 'instructions_required' });

  if (!validateInstanceId(instance_id)) instance_id = generateInstanceId();
  const traceId = trace_id || crypto.randomBytes(6).toString('hex');

  const paths = getInstancePaths(instance_id);
  ensureDir(paths.root);

  const merged = mergeConfig(instance_id, payload || {});
  const recipients = requireRecipients(merged.to, merged.cc, merged.bcc);
  if (!merged.subject) return sendJson(res, 400, { error: 'subject_missing_after_merge' });
  if (!recipients) return sendJson(res, 400, { error: 'recipients_missing_after_merge' });

  // Log launch receipt immediately
  await logEvent({
    service: SERVICE,
    level: 'info',
    event_type: 'record',
    message: 'Email-App Agent received call to launch',
    instance_id,
    username,
    trace_id: traceId
  });

  // Mark meta as active and stamp started_at
  markInstanceActive(instance_id, username);
  await logEvent({
    service: SERVICE,
    level: 'info',
    event_type: 'state_change',
    message: 'state - active',
    instance_id,
    username,
    trace_id: traceId
  });

  const runFlow = async () => {
    let genMeta = updateMeta(instance_id, (prev) => {
      const next = { ...(prev || {}) };
      next.gen_count = parseInt(next.gen_count || 0, 10) + 1;
      return next;
    });

    // Log before invoking the LLM so the record appears immediately
    await logEvent({
      service: SERVICE,
      level: 'info',
      event_type: 'record',
      message: 'Calling LLM to generate email',
      instance_id,
      username,
      trace_id: traceId
    });

    let authorResp = await callAuthorAgent({
      instance_id,
      username,
      instructions,
      base_html,
      subject: merged.subject,
      trace_id: traceId
    });

    // Submit to HITL
    const cfg = loadInstanceConfig(instance_id) || {};
    const hitlCfg = cfg['human-in-the-loop'] || cfg['hitl'] || cfg['HITL'] || {};
    const loopIdx = (genMeta && genMeta.gen_count ? genMeta.gen_count - 1 : 0);
    const hitlResult = await submitHitlAndHandle({
      instanceId: instance_id,
      username,
      html: authorResp.html,
      hitlConfig: hitlCfg,
      loopIndex: loopIdx,
      traceId
    });
    if (!hitlResult.accepted) {
      return {
        error: 'hitl_submit_failed',
        status: hitlResult.status,
        detail: hitlResult.error || hitlResult.hitlInfo || hitlResult.hitlStatus || undefined
      };
    }

    return {
      instance_id,
      trace_id: traceId,
      draft_html: authorResp.html,
      send_result: null
    };
  };

  if (payload.async === true) {
    setImmediate(async () => {
      try {
        await runFlow();
      } catch (e) {
        await logEvent({
          service: SERVICE,
          level: 'error',
          event_type: 'record',
          message: `Compose async error: ${e && e.message ? e.message : e}`,
          instance_id,
          username,
          trace_id: traceId
        });
      }
    });
    return sendJson(res, 202, { status: 'accepted', instance_id, trace_id: traceId });
  }

  try {
    const result = await runFlow();
    return sendJson(res, 200, result);
  } catch (e) {
    await logEvent({
      service: SERVICE,
      level: 'error',
      event_type: 'record',
      message: `Compose error: ${e && e.message ? e.message : e}`,
      instance_id,
      username,
      trace_id: traceId
    });
    return sendJson(res, 502, { error: 'compose_failed', detail: e && e.message ? e.message : e, instance_id, trace_id: traceId });
  }
}

function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true });
  if (req.method === 'POST' && url.pathname === '/compose/send') return handleComposeSend(req, res);
  if (req.method === 'POST' && url.pathname === '/compose/abort') return handleAbort(req, res);
  if (req.method === 'POST' && url.pathname === '/compose/hitl-callback') return handleHitlCallback(req, res);
  return sendJson(res, 404, { error: 'not_found' });
}

http.createServer(router).listen(PORT, () => {
  console.log(`[compose] listening on ${PORT}`);
});
