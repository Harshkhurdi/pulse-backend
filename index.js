require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

// Trust Vercel's proxy so express-rate-limit can read X-Forwarded-For
app.set('trust proxy', 1);

// Suppress browser favicon probes (returns 204 No Content).
app.get(['/favicon.ico', '/favicon.png'], (req, res) => res.status(204).end());

app.use((req, res, next) => {
  console.log(`[Incoming Request] ${req.method} ${req.url}`);
  next();
});

function configured(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// The service-role key is preferred, but an anon key is sufficient for the
// only Supabase operation this API performs: validating a caller's JWT.
// Supporting the alias makes the deployment less fragile without exposing a
// privileged database key to a function that does not need one.
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const configIssues = [];

if (!configured(process.env.SUPABASE_URL)) {
  configIssues.push('SUPABASE_URL');
} else {
  try {
    const supabaseUrl = new URL(process.env.SUPABASE_URL);
    if (!['https:', 'http:'].includes(supabaseUrl.protocol)) {
      configIssues.push('SUPABASE_URL (must start with https:// or http://)');
    }
  } catch {
    configIssues.push('SUPABASE_URL (must be a valid URL)');
  }
}
if (!configured(supabaseKey)) {
  configIssues.push('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY');
}
if (!configured(process.env.OPENROUTER_API_KEY)) {
  configIssues.push('OPENROUTER_API_KEY');
}

let envOk = configIssues.length === 0;
for (const issue of configIssues) {
  console.error(`CRITICAL: Invalid or missing server environment variable — ${issue}.`);
}

let supabaseAdmin;
if (envOk) {
  try {
    supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      supabaseKey,
      { auth: { persistSession: false } }
    );
  } catch (err) {
    console.error('CRITICAL: Failed to create Supabase client:', err.message);
    // `createClient` validates URL/key shape more strictly than the initial
    // presence check. Include a safe, actionable diagnosis in health output;
    // neither the URL nor any secret is ever returned.
    configIssues.push('SUPABASE_URL or Supabase API key is invalid');
    envOk = false;
  }
} else {
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
    timestamp: new Date().toISOString(),
    envOk,
    ...(envOk ? {} : { configurationIssues: configIssues }),
  });
});

// Fallback AI Models for OpenRouter to ensure high availability
// Primary is OpenRouter's auto-router: it picks a random healthy free model,
// so individual model outages never surface as errors to users.
const FALLBACK_AI_MODELS = [
  'openrouter/free',
  // Direct fallbacks, used only if the router endpoint itself fails.
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'cohere/north-mini-code:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'nvidia/nemotron-nano-9b-v2:free',
  'poolside/laguna-s-2.1:free',
  'poolside/laguna-xs-2.1:free',
];


app.post('/api/generate-update', async (req, res) => {
  if (!envOk || !supabaseAdmin) {
    return res.status(503).json({
      error: 'Backend configuration error. Configure the server environment variables and redeploy.',
      configurationIssues: configIssues,
    });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized. Missing or invalid token.' });
  }

  const token = authHeader.split(' ')[1];
  const {
    data: { user },
    error: authError,
  } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    return res.status(401).json({ error: 'Unauthorized. Invalid or expired token.' });
  }

  const { boardText, today } = req.body;
  if (!boardText || !today) {
    return res.status(400).json({ error: 'Missing required fields: boardText and today.' });
  }

  const prompt = `You are an experienced chief of staff writing a concise, stakeholder-ready status update from a project's task board.

Today's date: ${today}

Board:
${boardText}

Reason about status labels, due dates, blockers, and notes. Not every Blocked task is necessarily "at risk" if it has a comfortable due date; not every overdue task is a crisis if it's nearly done. Use sharp judgment.

Respond with ONLY valid JSON and nothing else — no markdown, no code fences — matching exactly this shape:
{"summary": "2-3 sentence stakeholder-ready narrative paragraph on overall project health", "shipped": ["short clause per completed task"], "inProgress": ["short clause per in-progress task noting where it stands"], "atRisk": [{"title": "task title", "reasoning": "one sentence on why this is genuinely at risk"}]}`;

  let lastError = null;

  for (const model of FALLBACK_AI_MODELS) {
    try {
      console.log(`[AI Request] Attempting status generation with model: ${model}`);
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
      });

      if (!response.ok) {
        const errText = await response.text();
        console.warn(`OpenRouter API error with model ${model}:`, response.status, errText);
        lastError = `Model ${model} returned ${response.status}`;
        continue; // Try next model
      }

      const data = await response.json();
      if (data.error) {
        console.warn(`OpenRouter response error with model ${model}:`, data.error);
        lastError = data.error.message || `Model ${model} error`;
        continue; // Try next model
      }

      const textBlocks = (data.choices || []).map((c) => c.message?.content || '').join('\n');
      if (!textBlocks.trim()) {
        lastError = `Model ${model} returned empty content`;
        continue;
      }

      const startIdx = textBlocks.indexOf('{');
      const endIdx = textBlocks.lastIndexOf('}');
      if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
        lastError = `Model ${model} returned invalid JSON`;
        continue;
      }

      const parsed = JSON.parse(textBlocks.slice(startIdx, endIdx + 1).trim());
      return res.json(parsed);
    } catch (err) {
      console.error(`Error trying model ${model}:`, err.message);
      lastError = err.message;
    }
  }

  return res.status(500).json({ error: `AI service temporarily unavailable. (${lastError})` });
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
