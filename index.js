require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createRemoteJWKSet, jwtVerify } = require('jose');

const app = express();
const PORT = process.env.PORT || 3001;
// Bump when a release matters for deployment verification: /api/health
// reports this so you can confirm Vercel is serving the pushed code.
const VERSION = '1.1.0';

// Trust Vercel's proxy so express-rate-limit can read X-Forwarded-For
app.set('trust proxy', 1);

// Vercel rewrites deliver the rewrite destination ("/index.js") as req.url
// on current builds. Each rewrite carries the real request path in the
// __path query param — restore it so Express routing sees the original URL.
app.use((req, _res, next) => {
  const mapped = req.query.__path;
  if (typeof mapped === 'string' && mapped.length > 0) {
    req.url = mapped;
  }
  next();
});

// Suppress browser favicon probes (returns 204 No Content).
app.get(['/favicon.ico', '/favicon.png'], (req, res) => res.status(204).end());

app.use((req, res, next) => {
  console.log(`[Incoming Request] ${req.method} ${req.url}`);
  next();
});

function configured(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Firebase ID tokens are JWTs signed with Google's rotating private keys and
// are publicly verifiable against Google's JWKS endpoint — no service-account
// private key is needed for the only operation this API performs: validating
// a caller's token. The project id scopes issuer and audience checks.
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const configIssues = [];

if (!configured(FIREBASE_PROJECT_ID)) {
  configIssues.push('FIREBASE_PROJECT_ID');
}
if (!configured(process.env.OPENROUTER_API_KEY)) {
  configIssues.push('OPENROUTER_API_KEY');
}

let envOk = configIssues.length === 0;
for (const issue of configIssues) {
  console.error(`CRITICAL: Invalid or missing server environment variable — ${issue}.`);
}

// Google's JWKS for Firebase ID tokens (securetoken service account).
const firebaseJWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

async function verifyFirebaseToken(token) {
  const { payload } = await jwtVerify(token, firebaseJWKS, {
    issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
    audience: FIREBASE_PROJECT_ID,
  });
  // payload.user_id is the Firebase uid; email is present for password accounts.
  return payload;
}

if (!envOk) {
  console.error('CRITICAL: Server starting with invalid environment configuration. Configure the deployment environment variables.');
}

app.use(express.json());

// CORS Configuration
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const localhostOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000'];
if (process.env.NODE_ENV !== 'production' && allowedOrigins.length === 0) {
  allowedOrigins.push(...localhostOrigins);
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin "${origin}" not allowed`));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Rate Limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
});

app.use('/api/', apiLimiter);

// Health Check Endpoints
app.get(['/', '/api/health'], (req, res) => {
  res.json({
    status: 'ok',
    service: 'Pulse Backend API',
    version: VERSION,
    timestamp: new Date().toISOString(),
    envOk,
    ...(envOk ? {} : { configurationIssues: configIssues }),
  });
});

// Primary model — ALWAYS tried first on every /api/generate-update call.
// OpenRouter's auto-router picks a healthy free model, so individual model
// outages never surface as errors to users.
const PRIMARY_AI_MODEL = 'openrouter/free';

// Direct fallbacks, used in order only if the primary fails.
const FALLBACK_AI_MODELS = [
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'cohere/north-mini-code:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'nvidia/nemotron-nano-9b-v2:free',
  'poolside/laguna-s-2.1:free',
  'poolside/laguna-xs-2.1:free',
];

const AI_MODELS = [PRIMARY_AI_MODEL, ...FALLBACK_AI_MODELS];

/** Shared bearer-token verification. Returns uid or null. */
async function authenticate(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.split(' ')[1];
  try {
    const payload = await verifyFirebaseToken(token);
    return payload.user_id || payload.sub || null;
  } catch (err) {
    console.warn('Firebase token verification failed:', err?.code || err?.message);
    return null;
  }
}

/** 401 response helper for routes using authenticate(). */
function unauthorized() {
  return { status: 401, body: { error: 'Unauthorized. Missing or invalid token.' } };
}

/**
 * Runs the prompt through the model chain: primary first, then fallbacks in
 * order, each with a hard 20s budget. Returns { ok: true, parsed } with the
 * first valid JSON object found, or { ok: false, lastError }.
 */
async function runModelChain(prompt, logLabel = 'status generation') {
  let lastError = null;
  for (const model of AI_MODELS) {
    try {
      console.log(`[AI Request] Attempting ${logLabel} with model: ${model}${model === PRIMARY_AI_MODEL ? ' (primary)' : ' (fallback)'}`);
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': allowedOrigins[0] || 'http://localhost:5173',
          'X-Title': 'Pulse - AI Status & Risk Assistant',
        },
        body: JSON.stringify({
          model: model,
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }],
        }),
        // Hard per-model budget: a hanging provider must never eat the
        // whole function duration — skip to the next model instead.
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        console.warn(`OpenRouter API error with model ${model}:`, response.status, errText);
        lastError = `Model ${model} returned ${response.status}`;
        continue;
      }

      const data = await response.json();
      if (data.error) {
        console.warn(`OpenRouter response error with model ${model}:`, data.error);
        lastError = data.error.message || `Model ${model} error`;
        continue;
      }

      const textBlocks = (data.choices || []).map((c) => c.message?.content || '').join('\n');
      if (!textBlocks.trim()) {
        lastError = `Model ${model} returned empty content`;
        continue;
      }

      const startIdx = textBlocks.indexOf('{');
      const endIdx = textBlocks.lastIndexOf('}');
      if (startIdx === -1 || endIdx < startIdx) {
        lastError = `Model ${model} returned invalid JSON`;
        continue;
      }

      const parsed = JSON.parse(textBlocks.slice(startIdx, endIdx + 1).trim());
      console.log(`[AI Request] ${logLabel} done with model: ${model}${model === PRIMARY_AI_MODEL ? ' (primary)' : ' (fallback)'}`);
      return { ok: true, parsed };
    } catch (err) {
      console.error(`Error trying model ${model}:`, err.message);
      lastError = err.message;
    }
  }
  return { ok: false, lastError };
}

app.post('/api/generate-update', async (req, res) => {
  if (!envOk) {
    return res.status(503).json({
      error: 'Backend configuration error. Configure the server environment variables and redeploy.',
      configurationIssues: configIssues,
    });
  }

  const uid = await authenticate(req);
  if (!uid) {
    return res.status(401).json({ error: 'Unauthorized. Missing or invalid token.' });
  }

  const { boardText, today } = req.body;
  if (!boardText || !today) {
    return res.status(400).json({ error: 'Missing required fields: boardText and today.' });
  }

  const prompt = `You are an experienced chief of staff writing a concise, stakeholder-ready status update from a project's task board.

Today's date: ${today}

Board:
${boardText}

Reason about status labels, priorities (Urgent/High tasks weigh more heavily in risk judgment), tags, due dates, blockers, and notes. Not every Blocked task is necessarily "at risk" if it has a comfortable due date; not every overdue task is a crisis if it's nearly done. Use sharp judgment.

Respond with ONLY valid JSON and nothing else — no markdown, no code fences — matching exactly this shape:
{"summary": "2-3 sentence stakeholder-ready narrative paragraph on overall project health", "shipped": ["short clause per completed task"], "inProgress": ["short clause per in-progress task noting where it stands"], "atRisk": [{"title": "task title", "reasoning": "one sentence on why this is genuinely at risk"}]}`;

  const result = await runModelChain(prompt, 'status generation');
  if (!result.ok) {
    return res.status(500).json({ error: `AI service temporarily unavailable. (${result.lastError})` });
  }
  return res.json(result.parsed);
});

/**
 * POST /api/suggest-subtasks  { title, notes?, priority? }
 * AI breakdown: returns 3-5 concrete subtask titles for a task.
 * Authenticated with a Firebase ID token, same as generate-update.
 */
app.post('/api/suggest-subtasks', async (req, res) => {
  if (!envOk) {
    return res.status(503).json({
      error: 'Backend configuration error. Configure the server environment variables and redeploy.',
      configurationIssues: configIssues,
    });
  }

  const uid = await authenticate(req);
  if (!uid) {
    return res.status(401).json({ error: 'Unauthorized. Missing or invalid token.' });
  }

  const { title, notes, priority } = req.body;
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'Missing required field: title.' });
  }

  const prompt = `You are a senior project manager breaking a task into subtasks.

Task: "${title.trim()}"
${priority && priority !== 'normal' ? `Priority: ${priority}\n` : ''}${notes && notes.trim() ? `Context: ${notes.trim()}\n` : ''}
Write 3 to 5 concrete, actionable subtasks that together complete this task. Each subtask:
- starts with a strong verb (Draft, Call, Review, Deploy, …)
- is 4 to 10 words, self-contained
- is ordered in logical execution sequence

Respond with ONLY valid JSON and nothing else — no markdown, no code fences — matching exactly this shape:
{"subtasks": ["First subtask", "Second subtask", "Third subtask"]}`;

  const result = await runModelChain(prompt, 'subtask suggestions');
  if (!result.ok) {
    return res.status(500).json({ error: `AI service temporarily unavailable. (${result.lastError})` });
  }

  const raw = Array.isArray(result.parsed.subtasks) ? result.parsed.subtasks : [];
  const subtasks = raw
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim())
    .slice(0, 6);
  return res.json({ subtasks });
});

// Start listener for standalone node process
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Pulse backend running on http://localhost:${PORT}`);
  });
}

// Exposed for no-network unit tests only; no secret values are included.
app.pulseConfig = { envOk, configurationIssues: [...configIssues] };
module.exports = app;
