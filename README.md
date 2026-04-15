# commcare nova

A web app for designing CommCare applications through natural language conversation. Describe what you need, and Nova builds a fully structured CommCare app — forms, case management, logic, and all. Then keep editing it conversationally or directly in the visual builder.

## How it works

Nova uses a single AI agent — the **Solutions Architect (SA)** — powered by Anthropic's Claude via the Vercel AI SDK. The SA converses with users to understand requirements, generates a complete app blueprint through tool calls, and handles subsequent edits in the same conversational interface.

Users authenticate via Google OAuth, and each app is persisted to Firestore with full ownership tracking. After initial generation, users can revisit their apps, edit them through chat or the visual builder, and pick up where they left off. Chat history is preserved per-app as threaded conversations.

Three routes do all the work: `/` (app list or get-started), `/build/[id]` (the builder — generation, editing, and upload to CommCare HQ), and `/settings` (CommCare HQ credentials). An admin dashboard at `/admin` provides user management and usage visibility.

## Getting started

### Local

```bash
cp .env.example .env   # Fill in auth + Firestore credentials
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Docker

```bash
docker build -t commcare-nova .
docker run -p 8080:8080 commcare-nova
```

### Deploy to Cloud Run

```bash
gcloud run deploy nova --source . --region <region>
```

Cloud Run builds the image from the Dockerfile automatically. Configure auth secrets, Anthropic API key, and Firestore project via environment variables or Secret Manager.

### Cloud KMS setup

CommCare HQ API keys are encrypted at rest using a Cloud KMS symmetric key. Create the key ring and key in the same region as Cloud Run:

```bash
gcloud kms keyrings create nova --location=us-central1
gcloud kms keys create commcare-api-keys --keyring=nova --location=us-central1 --purpose=encryption
```

Grant the Cloud Run service account the encrypter/decrypter role:

```bash
gcloud kms keys add-iam-policy-binding commcare-api-keys \
  --keyring=nova --location=us-central1 \
  --member="serviceAccount:$(gcloud run services describe nova --region=us-central1 --format='value(spec.template.spec.serviceAccountName)')" \
  --role="roles/cloudkms.cryptoKeyEncrypterDecrypter"
```

The key resource is derived from `GOOGLE_CLOUD_PROJECT` — no extra env var needed. Enable automatic rotation in the GCP console or via `gcloud kms keys update ... --rotation-period=90d`.

## Commands

```bash
npm run dev        # Turbopack dev server
npm run build      # production build
npm run lint       # Biome lint + format check
npm run format     # Biome auto-format
npm test           # vitest
```

Production diagnostic scripts live in `scripts/` and are excluded from Docker. Run any with `--help` for usage. Requires `gcloud auth application-default login`.

A [Lefthook](https://github.com/evilmartians/lefthook) pre-commit hook runs `biome check --staged`. It installs automatically on `npm install`.

## Stack

- **Next.js 16** (App Router, Turbopack) · **TypeScript** strict · **Tailwind CSS v4**
- **Vercel AI SDK** + **Anthropic Claude** — streaming chat, tool calls, structured output
- **Better Auth** — Google OAuth with Firestore-backed sessions
- **Google Cloud Firestore** — app persistence, chat threads, event logging, usage
- **Google Cloud KMS** — credential encryption at rest
- **Zustand** (builder state) · **Motion** (animations) · **dnd-kit** (drag) · **TipTap 3** (rich text) · **Base UI** (floating elements)
- **Vitest**

## Developer tools

- `/build/replay/[id]` — admin-only replay of saved event logs through the builder UI with no API calls. Useful for iterating on UI without re-running generation.
- `/xpath-test` — CodeMirror-backed XPath playground for testing syntax highlighting and formatting.
- `/signal-test` — Signal Grid tuning page for the neural-activity panel.
- `/error-test` — simulates error scenarios end-to-end (invalid API key, stream errors, rate limiting, etc.) so error-state UI can be verified without a real failure.
