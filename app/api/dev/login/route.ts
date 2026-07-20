/**
 * Local-dev only — one-URL sign-in for agents, scripts, and browsers.
 *
 * Google SSO can't be driven headlessly, so every local automation (AI agents
 * driving the UI, curl against authed APIs, manual browser poking) needs a
 * session without the OAuth dance. Visiting this route mints one for real:
 * it upserts a `@dimagi.com` agent user + personal Project, writes a live
 * session row through Better Auth's own adapter, and sets the signed session
 * cookie (`lib/auth/sessionCookie.ts` — the same signer the smoke suite uses,
 * contract-pinned by `lib/db/__tests__/sessionCookie.integration.test.ts`),
 * then redirects. From there the client is simply logged in.
 *
 *   browser / agent:  navigate to  http://localhost:3000/api/dev/login
 *   curl:             curl -c /tmp/jar 'http://localhost:3000/api/dev/login'
 *                     curl -b /tmp/jar 'http://localhost:3000/api/auth/get-session'
 *
 * Query params: `next` (relative redirect target, default `/`) and `as`
 * (identity slug — `?as=alice` yields a second user `agent-alice@dimagi.com`,
 * e.g. for driving multiplayer/sharing flows from two contexts).
 *
 * Prod-safety, two independent layers: the handler 404s outside
 * `NODE_ENV=development` (same gate as `app/api/media/upload/dev-put`), and
 * the route is deliberately ABSENT from the main-host allowlist in
 * `lib/hostnames.ts`, so on the production hosts the proxy 404s the path
 * before this module even loads. Keep it off that allowlist. The handler also
 * refuses to run without `NOVA_DB_LOCAL_URL` — the same guard `e2e/seed.ts`
 * uses to keep forged sessions off the real Cloud SQL instance.
 */

import { randomBytes } from "node:crypto";
import { ApiError, handleApiError } from "@/lib/apiError";
import { getAuth } from "@/lib/auth";
import { ensurePersonalProject } from "@/lib/auth/provisionProject";
import { sessionCookieName, signSessionCookie } from "@/lib/auth/sessionCookie";

/** Long-lived on purpose — a local agent session should outlast a workday. */
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

interface AgentIdentity {
	userId: string;
	email: string;
	name: string;
}

/** Default agent identity; `?as=<slug>` derives siblings for multi-user flows. */
const DEFAULT_IDENTITY: AgentIdentity = {
	userId: "local-agent",
	email: "agent@dimagi.com",
	name: "Local Agent",
};

const IDENTITY_SLUG = /^[a-z0-9-]{1,32}$/;

function identityFor(as: string | null): AgentIdentity {
	if (as === null) return DEFAULT_IDENTITY;
	if (!IDENTITY_SLUG.test(as)) {
		throw new ApiError(
			`dev-login: \`as\` must match ${IDENTITY_SLUG} (it becomes the user id and email local-part) — got \`${as}\`.`,
			400,
		);
	}
	return {
		userId: `local-agent-${as}`,
		email: `agent-${as}@dimagi.com`,
		name: `Agent ${as}`,
	};
}

export async function GET(request: Request): Promise<Response> {
	try {
		// Prod-safety: this login backdoor exists only in local development.
		if (process.env.NODE_ENV !== "development") {
			throw new ApiError("Not found", 404);
		}
		if (!process.env.NOVA_DB_LOCAL_URL) {
			throw new ApiError(
				"dev-login refuses to run without NOVA_DB_LOCAL_URL — it writes a forged session, and that env var is the guard keeping such writes on the local compose Postgres, never the real Cloud SQL instance. Set it in .env (see .env.example) and restart `npm run dev`.",
				500,
			);
		}
		const secret = process.env.BETTER_AUTH_SECRET;
		if (!secret) {
			throw new ApiError(
				"dev-login needs BETTER_AUTH_SECRET to sign the session cookie, but it's unset. Set it in .env (see .env.example) and restart `npm run dev`.",
				500,
			);
		}

		const url = new URL(request.url);
		const identity = identityFor(url.searchParams.get("as"));
		const next = url.searchParams.get("next") ?? "/";
		if (!next.startsWith("/") || next.startsWith("//")) {
			throw new ApiError(
				`dev-login: \`next\` must be a same-origin path starting with \`/\` — got \`${next}\`.`,
				400,
			);
		}

		const auth = await getAuth();
		const ctx = await auth.$context;
		const now = new Date();

		// Adapter-direct like `e2e/seed.ts`: bypasses the OAuth-callback-only
		// domain-allowlist hook, which is fine — the identity is @dimagi.com.
		const existing = await ctx.adapter.findOne({
			model: "user",
			where: [{ field: "id", value: identity.userId }],
		});
		if (!existing) {
			await ctx.adapter.create({
				model: "user",
				forceAllowId: true,
				data: {
					id: identity.userId,
					name: identity.name,
					email: identity.email,
					emailVerified: true,
					image: null,
					role: "user",
					banned: false,
					createdAt: now,
					updatedAt: now,
					lastActiveAt: now,
				},
			});
		}
		// Eager so the first page load doesn't pay the lazy get-or-create
		// (`resolveActiveProjectId` would provision it anyway).
		await ensurePersonalProject(identity.userId);

		const token = randomBytes(32).toString("hex");
		await ctx.adapter.create({
			model: "session",
			data: {
				token,
				userId: identity.userId,
				expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
				createdAt: now,
				updatedAt: now,
				ipAddress: "",
				userAgent: "dev-login",
			},
		});

		const cookie = [
			`${sessionCookieName(url.origin)}=${signSessionCookie(token, secret)}`,
			"Path=/",
			"HttpOnly",
			"SameSite=Lax",
			`Max-Age=${SESSION_TTL_SECONDS}`,
		].join("; ");
		return new Response(null, {
			status: 303,
			headers: {
				"Set-Cookie": cookie,
				Location: next,
				"Cache-Control": "no-store",
			},
		});
	} catch (err) {
		return handleApiError(err as Error);
	}
}
