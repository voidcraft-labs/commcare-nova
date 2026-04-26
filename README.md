# commcare nova

A web app for designing CommCare applications through natural language conversation. Describe what you need, and Nova builds a fully structured CommCare app — forms, case management, logic, and all. Then keep editing it conversationally or directly in the visual builder.

## How it works

Nova uses a single AI agent — the **Solutions Architect (SA)** — powered by Anthropic's Claude via the Vercel AI SDK. The SA converses with users to understand requirements, generates a complete app blueprint through tool calls, and handles subsequent edits in the same conversational interface.

Users authenticate via Google OAuth, and each app is persisted to Firestore with full ownership tracking. After initial generation, users can revisit their apps, edit them through chat or the visual builder, and pick up where they left off. Chat history is preserved per-app as threaded conversations.

Three routes do all the work: `/` (app list or get-started), `/build/[id]` (the builder — generation, editing, and upload to CommCare HQ), and `/settings` (CommCare HQ credentials). An admin dashboard at `/admin` provides user management and usage visibility.

The same tool surface the in-app SA uses is also reachable from outside via an MCP endpoint — `/api/mcp`, served at `mcp.commcare.app/mcp` in production. External MCP clients (e.g., the [nova-plugin](https://github.com/voidcraft-labs/nova-plugin) for Claude Code) authenticate over OAuth 2.1 and drive the same generation / editing / upload tools the chat agent uses. Public docs live at [docs.commcare.app](https://docs.commcare.app).

## Architecture

One Cloud Run service serves three hostnames, separated by middleware (`proxy.ts`) reading the `Host` header:

- `commcare.app` — main builder app, `/api/auth`, `/api/chat`, OAuth authorization-server metadata.
- `mcp.commcare.app` — MCP API only. Externally exposed `/mcp` rewrites internally to `/api/mcp`.
- `docs.commcare.app` — public docs site (fumadocs). Per-host allowlists in `lib/hostnames.ts` 404 anything off the list.

Per-host details — including the route-group layout under `app/`, the chat-vs-MCP split, and the fail-closed Firestore persistence model — live in [`CLAUDE.md`](./CLAUDE.md).

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
npm run dev               # Turbopack dev server
npm run build             # production build
npm run lint              # Biome lint + format check
npm run format            # Biome auto-format
npm test                  # vitest (unit tests)
npm run test:integration  # vitest against the Firestore emulator (see below)
```

Production diagnostic scripts live in `scripts/` and are excluded from Docker. Run any with `--help` for usage. Requires `gcloud auth application-default login`.

A [Lefthook](https://github.com/evilmartians/lefthook) pre-commit hook runs `biome check --staged`. It installs automatically on `npm install`.

## Integration tests

Some tests run against a real Firestore emulator instead of hand-rolled mocks — they catch schema-boundary bugs that pure unit tests can't, since the test author chooses both sides of a mock and a wrong assumption goes undetected. These live in files matching `**/*.integration.test.ts` and are skipped by default in `npm test`.

To run them:

```bash
npm run test:integration
```

The script wraps `firebase emulators:exec` around vitest, so the emulator starts and stops automatically per run. **Java 21+ is required** — the Firestore emulator is a JVM process, and `firebase-tools` 14+ rejects older JDKs.

On macOS:

```bash
brew install openjdk
```

Then add to your shell profile (`.zshrc` / `.bashrc`):

```bash
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"   # Apple Silicon
# export PATH="/usr/local/opt/openjdk/bin:$PATH"    # Intel
export JAVA_HOME="/opt/homebrew/opt/openjdk"        # adjust accordingly
```

Verify with `java -version` (should report 21+). On Linux, install OpenJDK 21+ via your package manager (`apt install openjdk-21-jdk` or similar) and ensure `JAVA_HOME` points at it.

Tests that need the emulator self-skip when `FIRESTORE_EMULATOR_HOST` is unset, so contributors who only run `npm test` don't have to install Java.

## Stack

- **Next.js 16** (App Router, Turbopack) · **TypeScript** strict · **Tailwind CSS v4**
- **Vercel AI SDK** + **Anthropic Claude** — streaming chat, tool calls, structured output
- **mcp-handler** + **@modelcontextprotocol/sdk** — `/api/mcp` streamable-HTTP server exposing the SA's tools to external clients
- **Better Auth** + **@better-auth/oauth-provider** — Google OAuth for the app, OAuth 2.1 authorization server for MCP clients
- **Google Cloud Firestore** — app persistence, chat threads, event logging, usage
- **Google Cloud KMS** — credential encryption at rest
- **Zustand** (builder state) · **Motion** (animations) · **Pragmatic Drag and Drop** · **TipTap 3** (rich text) · **Base UI** (floating elements)
- **fumadocs** — docs.commcare.app static site
- **Vitest**

## Plugin development

The [nova-plugin](https://github.com/voidcraft-labs/nova-plugin) is a flat-file Claude Code plugin whose `.mcp.json` pins the production URL `https://mcp.commcare.app/mcp` — by design, with no env-var substitution, so the published artifact is immutable from the user's environment. To iterate on the plugin against your local Nova:

```bash
npm run dev                                                 # 1. Nova on localhost:3000
./scripts/nova-plugin-dev.sh                                # 2. claude with --plugin-dir overlay → localhost
./scripts/nova-plugin-dev.sh --nova-plugin /path/to/clone   #    custom clone location
NOVA_MCP_URL=https://staging.example.com/api/mcp ./scripts/nova-plugin-dev.sh   # alt server
```

The script materializes a gitignored `.dev-plugin/` overlay inside the plugin repo with a generated `.mcp.json` pointing at localhost, then execs `claude --plugin-dir <overlay>`. Claude Code's session-only plugins **override** installed plugins by name, so if you also have the production `nova` plugin installed at user scope it's transparently shadowed for that session and reverts on exit — no uninstall/reinstall needed.

The script defaults to a sibling clone at `<commcare-nova>/../nova-plugin`. Override with `--nova-plugin <path>` if your layout differs; the script errors with a clone hint if it can't find a Claude plugin root at the resolved location.

## Developer tools

- `/build/replay/[id]` — admin-only replay of saved event logs through the builder UI with no API calls. Useful for iterating on UI without re-running generation.
- `/xpath-test` — CodeMirror-backed XPath playground for testing syntax highlighting and formatting.
- `/signal-test` — Signal Grid tuning page for the neural-activity panel.
- `/error-test` — simulates error scenarios end-to-end (invalid API key, stream errors, rate limiting, etc.) so error-state UI can be verified without a real failure.
