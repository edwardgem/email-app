// author-agent: generates HTML emails (initial + regen) using prompt rules.
// This version uses no external dependencies; replace the stubbed LLM call as needed.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const {
  getInstancePaths,
  ensureDir,
  appendLlmTrace,
  appendLocalLog,
  logEvent,
  validateInstanceId,
  getLLMConfigFromEnv,
  loadInstanceEnv,
  loadInstanceConfig
} = require('../shared');

const PORT = Number(process.env.AUTHOR_PORT || process.env.PORT || 4101);
const SERVICE = 'author-agent';

function resolvePromptPath(instanceRoot, instanceConfig, instanceEnv) {
  // Priority: per-instance config PROMPT_FILE (relative to instance root if not absolute),
  // then per-instance env PROMPT_FILE, then service-level PROMPT_FILE, then bundled prompt.txt.
  const fromConfig = instanceConfig && instanceConfig.PROMPT_FILE;
  if (fromConfig) {
    const p = path.isAbsolute(fromConfig) ? fromConfig : path.join(instanceRoot, fromConfig);
    if (fs.existsSync(p)) return p;
  }
  const fromInstanceEnv = instanceEnv && instanceEnv.PROMPT_FILE;
  if (fromInstanceEnv) {
    const p = path.isAbsolute(fromInstanceEnv) ? fromInstanceEnv : path.join(instanceRoot, fromInstanceEnv);
    if (fs.existsSync(p)) return p;
  }
  const fromService = process.env.PROMPT_FILE;
  if (fromService && fs.existsSync(fromService)) return fromService;
  return path.join(__dirname, 'prompt.txt');
}

function readPromptText(promptPath) {
  try {
    return fs.readFileSync(promptPath, 'utf8');
  } catch (_) {
    return 'You are an email authoring agent. Generate concise, professional HTML emails.';
  }
}

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

function buildPrompt({ instructions, baseHtml, promptText }) {
  const jsonContract =
    'Return ONLY JSON per the schema:\n' +
    '{\n' +
    '  "reasoning": {\n' +
    '    "summary": "<string>",\n' +
    '    "key_facts": "<string>",\n' +
    '    "key_instructions": "<string>",\n' +
    '    "policy_rules_applied": "<string>",\n' +
    '    "assumptions": "<string>",\n' +
    '    "uncertainty_level": "<low|medium|high>"\n' +
    '  },\n' +
    '  "answer": "<string>"\n' +
    '}\n' +
    'Populate "answer" with the complete HTML email. Do not return any content outside of the JSON contract.';

  const hasInstructions = instructions && instructions.trim();
  const keyBlock = hasInstructions ? `\n\n[KEY INSTRUCTIONS]\n${instructions.trim()}\n` : '';
  const instructionReminder = hasInstructions
    ? '\n\nWhen producing JSON, mention the instructions you considered while generating the email and keep reasoning.key_instructions to a concise summary of how you applied them (never copy the literal "[KEY INSTRUCTIONS]" label or quote the raw text verbatim).'
    : '\n\nIf there are no [KEY INSTRUCTIONS], rely solely on the base prompt.';
  const enforcement = '\nEnsure the final HTML answer reflects every applicable instruction.';
  if (!baseHtml) {
    const prompt = (hasInstructions ? `${promptText}${keyBlock}` : promptText) + `${instructionReminder}${enforcement}\n\n${jsonContract}`;
    return { prompt, usedExistingHtml: false };
  }
  // With base HTML, focus on applying prompt + optional instructions to the provided HTML.
  const header = 'Apply only the [KEY INSTRUCTIONS] (if provided) to the included HTML email to produce the updated HTML email.';
  const prompt = `${header}${keyBlock}${instructionReminder}${enforcement}\n\nHere is the current HTML email to modify:\n\n\`\`\`html\n${baseHtml}\n\`\`\`\n\n${jsonContract}`;
  return { prompt, usedExistingHtml: true };
}

function stubGenerateHtml({ instructions, baseHtml }) {
  const bodyText = instructions && instructions.trim() ? instructions.trim() : 'No additional instructions provided.';
  if (baseHtml && baseHtml.trim()) {
    return baseHtml; // Preserve supplied HTML verbatim for stub behavior.
  }
  // Minimal HTML shell for first run.
  return [
    '<html>',
    '<body style="font-family: Arial, sans-serif; padding: 16px;">',
    `<p>${bodyText}</p>`,
    '</body>',
    '</html>'
  ].join('\n');
}

function rotateEmailFiles(emailPath) {
  // If email.html exists, shift it to email-1.html, email-1.html -> email-2.html, etc.
  if (!fs.existsSync(emailPath)) return;
  const dir = path.dirname(emailPath);
  const base = path.basename(emailPath, '.html'); // email
  const ext = '.html';
  let n = 1;
  while (fs.existsSync(path.join(dir, `${base}-${n}${ext}`))) {
    n += 1;
  }
  // Move highest to next slot, descending
  for (let i = n - 1; i >= 1; i -= 1) {
    const src = path.join(dir, `${base}-${i}${ext}`);
    const dest = path.join(dir, `${base}-${i + 1}${ext}`);
    fs.renameSync(src, dest);
  }
  fs.renameSync(emailPath, path.join(dir, `${base}-1${ext}`));
}

async function callOpenAI({ model, apiKey, endpoint, prompt, options }) {
  const url = (endpoint || 'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions';
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    ...options
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`openai_error_${res.status}: ${text}`);
  }
  const data = await res.json();
  const choice = data && data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content ? choice.message.content : '';
  return { html: content || '', model_used: data.model || model, reasoning: data };
}

async function callOllama({ model, endpoint, prompt, options }) {
  const url = (endpoint || 'http://127.0.0.1:11434').replace(/\/$/, '') + '/api/generate';
  const body = { model, prompt, ...options };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ollama_error_${res.status}: ${text}`);
  }
  const data = await res.json();
  const html = data && data.response ? data.response : '';
  return { html, model_used: model, reasoning: data };
}

async function generateHtmlWithLLM({ llmCfg, prompt }) {
  const provider = (llmCfg.provider || 'openai').toLowerCase();
  if (provider === 'ollama') {
    return callOllama({ model: llmCfg.model, endpoint: llmCfg.endpoint, prompt, options: llmCfg.options });
  }
  if (!llmCfg.apiKey) {
    throw new Error('openai_api_key_missing');
  }
  return callOpenAI({ model: llmCfg.model, apiKey: llmCfg.apiKey, endpoint: llmCfg.endpoint, prompt, options: llmCfg.options });
}

function cleanHtmlOutput(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  const startIdx = lower.indexOf('<html');
  const endIdx = lower.lastIndexOf('</html>');
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return trimmed.slice(startIdx, endIdx + '</html>'.length).trim();
  }
  // Fallback: strip any markdown-style ### Summary blocks appended at the end
  const summaryIdx = lower.lastIndexOf('### summary');
  if (summaryIdx > -1) {
    return trimmed.slice(0, summaryIdx).trim();
  }
  return trimmed;
}

function parseLlmJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.answer) {
      return parsed;
    }
  } catch (_) {}
  return null;
}

async function handleGenerate(req, res) {
  let payload;
  try { payload = await parseJsonBody(req); }
  catch (_) { return send(res, 400, { error: 'invalid_json' }); }

  const { instance_id, username, instructions = '', base_html = '', subject = '', trace_id } = payload || {};
  if (!validateInstanceId(instance_id)) return send(res, 400, { error: 'instance_id_required' });
  if (!username) return send(res, 400, { error: 'username_required' });

  // Load per-instance config and env overrides.
  const instanceConfig = loadInstanceConfig(instance_id);
  const instanceEnv = loadInstanceEnv(instance_id);
  const llmCfg = getLLMConfigFromEnv(instanceEnv);
  const modelName = llmCfg.model || 'stub-model';

  const paths = getInstancePaths(instance_id);
  const promptPath = resolvePromptPath(paths.root, instanceConfig, instanceEnv);
  const promptText = readPromptText(promptPath);

  const promptInfo = buildPrompt({ instructions, baseHtml: base_html, promptText });
  let html = '';
  let reasoning = {};
  let modelUsed = modelName;

  try {
    const llmResult = await generateHtmlWithLLM({ llmCfg, prompt: promptInfo.prompt });
    const raw = llmResult.html || '';
    const parsed = parseLlmJson(raw);
    if (parsed) {
      html = cleanHtmlOutput(parsed.answer || '');
      reasoning = parsed.reasoning || {};
    } else {
      html = cleanHtmlOutput(raw);
      reasoning = llmResult.reasoning || {};
    }
    modelUsed = llmResult.model_used || modelName;
  } catch (err) {
    // Fallback to stub on error
    html = stubGenerateHtml({ instructions, baseHtml: base_html });
    reasoning = { summary: `LLM error (${err && err.message ? err.message : err}); used stub fallback.`, used_existing_html: promptInfo.usedExistingHtml };
  }

  const { artifactsDir, draftHtml } = getInstancePaths(instance_id);
  ensureDir(artifactsDir);
  rotateEmailFiles(draftHtml);
  fs.writeFileSync(draftHtml, html, 'utf8');
  appendLocalLog(instance_id, 'author-agent', 'Generated email HTML and saved to artifacts/email.html');

  const traceEntry = {
    call_time: new Date().toISOString(),
    model: modelUsed,
    prompt: promptInfo.prompt,
    reasoning,
    answer: html,
    trace_id: trace_id || null
  };
  appendLlmTrace(instance_id, traceEntry);

  await logEvent({
    service: SERVICE,
    level: 'info',
    event_type: 'progress',
    message: 'Generated draft HTML',
    instance_id,
    username,
    trace_id
  });

  return send(res, 200, { html, model: modelUsed, trace_id: trace_id || null, reasoning });
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
  if (req.method === 'POST' && url.pathname === '/generate') return handleGenerate(req, res);
  return send(res, 404, { error: 'not_found' });
}

http.createServer(router).listen(PORT, () => {
  console.log(`[author-agent] listening on ${PORT}`);
});
