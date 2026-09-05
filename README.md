# Pulse Backend API

Pulse Backend is a serverless-ready Node.js & Express API that verifies Firebase Authentication ID tokens and interfaces with OpenRouter AI to generate executive status updates for task boards with multi-model fallback.

---

## 🚀 Quick Start (Local Development)

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Edit `.env` and fill in your keys:
```env
PORT=3001
FIREBASE_PROJECT_ID=your-firebase-project-id
OPENROUTER_API_KEY=your-openrouter-api-key
ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000
```

### 3. Run Locally
```bash
npm run dev
```
The server will start on `http://localhost:3001`.

---

## 🛠️ API Endpoints

- **`GET /` & `GET /api/health`** — Health check endpoint returning status, timestamp, and whether required deployment configuration is valid. When configuration is missing, it lists variable names only (never values).
- **`POST /api/generate-update`** — Authenticated endpoint expecting a Firebase ID token Bearer token in the `Authorization` header. The token is verified against Google's public JWKS endpoint (issuer `https://securetoken.google.com/<project-id>`, audience = project id), so no service-account private key is required. Takes `{ boardText, today }` payload and generates JSON status update using OpenRouter multi-model fallback.

---

## ☁️ Vercel Deployment Guide

1. **Import Repository to Vercel**:
   - Go to [Vercel Dashboard](https://vercel.com/new) -> Import `Harshkhurdi/pulse-backend`.

2. **Configure Environment Variables**:
   Add the following variables in Vercel Project Settings:
   - `FIREBASE_PROJECT_ID`: Your Firebase project id (e.g. `pulse-app-b2bd6`)
   - `OPENROUTER_API_KEY`: Your OpenRouter API Key
   - `ALLOWED_ORIGINS`: Exact frontend origins, e.g. `https://your-frontend.vercel.app,http://localhost:5173`. Do not leave this unset in production.

3. **Deploy**:
   - Click **Deploy**. Vercel uses `vercel.json` to handle serverless function routing automatically.
   - Note down your deployed Backend URL (e.g. `https://pulse-backend.vercel.app`).

4. **Apply to all Vercel environments**:
   - Add the variables to the Production environment (and Preview too, if you use preview URLs), then redeploy. Environment-variable edits do not change an already-running Vercel deployment.
   - Verify `https://your-backend.vercel.app/api/health` reports `"envOk": true` before testing Generate Update.
