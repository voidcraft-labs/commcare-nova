/**
 * Streamable HTTP MCP endpoint for Nova — entry shim.
 *
 * The Next.js wire path on the MCP host is `mcp.commcare.app/mcp`
 * (rewritten in-process to `/api/mcp` by `proxy.ts`). The actual
 * auth + dispatch logic lives behind Better Auth's `auth.handler` so
 * the route is protected by the framework's `onRequestRateLimit`
 * middleware (configured via `customRules` in `lib/auth.ts`). Without
 * this layer the route would be a public Firestore-read sink for
 * anyone spamming `Bearer sk-nova-v1-*` garbage.
 *
 * ## Why a synthesized request
 *
 * Next.js middleware rewrites the routing target but DO NOT update
 * `Request.url` — the route handler at this file still sees the
 * client's original wire URL (`/mcp` or `/api/mcp`). Better Auth's
 * router strips its `/api/auth` basePath from `req.url.pathname` to
 * locate the matching endpoint; a wire URL of `/mcp` with no
 * `/api/auth` prefix yields an empty path inside better-call's
 * router and 404s. So we synthesize a new Request whose URL contains
 * `/api/auth/mcp`, preserving body / method / headers, and hand it
 * to `auth.handler`. The plugin endpoint registered at `/mcp`
 * (relative to `/api/auth`) then matches.
 *
 * ## Why `duplex: 'half'`
 *
 * Node's `fetch`-shaped `Request` constructor requires `duplex:
 * 'half'` whenever the body is a streaming source (`ReadableStream`,
 * which is what Next.js hands us for non-empty POST bodies). Without
 * it, the constructor throws `RequestInit: duplex option is required
 * when sending a body`. The TypeScript DOM lib doesn't carry this
 * field yet (it's in WHATWG Fetch but not in DOM lib); the
 * `@ts-expect-error` is the conventional handling. The body still
 * gets consumed exactly once — by `mcp-handler` deep inside the
 * dispatcher.
 */

import { getAuth } from "@/lib/auth";
import { log } from "@/lib/logger";

/**
 * Next.js App Router segment config (`maxDuration` is the magic export
 * name Next reads for the platform-level request timeout). Must be a
 * literal — Next's static analysis rejects imported / computed values.
 * The protocol-level `mcp-handler` cutoff lives in `dispatch.ts`'s
 * `MCP_MAX_DURATION_SECONDS` and matches this number; both layers
 * exist because they enforce different things (platform vs protocol).
 * Keep these two values in sync.
 */
export const maxDuration = 300;

/**
 * Auth router basePath under which the Nova MCP plugin endpoint is
 * registered. Better Auth defaults `options.basePath` to `/api/auth`
 * (see `node_modules/better-auth/dist/context/create-context.mjs`),
 * which the project does not override. Hardcoded as a literal here
 * because the value is also baked into the synthesized URL below;
 * if the project ever sets `basePath: ...` in `lib/auth.ts`, this
 * literal must move with it.
 *
 * Exported so a test can pin the cross-module invariant that this
 * synthesized path agrees with the `basePath` `dispatch.ts` hands
 * `mcp-handler` — drift on either side reintroduces a production 404.
 */
export const AUTH_BASE_PATH = "/api/auth";

/**
 * Wire-path suffix the plugin endpoint registers under. Concatenated
 * with `AUTH_BASE_PATH` to form the synthesized URL the request gets
 * rewritten to before reaching `auth.handler`. Exported alongside
 * `AUTH_BASE_PATH` for the same cross-module invariant test.
 */
export const MCP_ENDPOINT_PATH = "/mcp";

const dispatch = async (req: Request): Promise<Response> => {
	let authReq: Request;
	try {
		const url = new URL(req.url);
		url.pathname = `${AUTH_BASE_PATH}${MCP_ENDPOINT_PATH}`;
		authReq = new Request(url, {
			method: req.method,
			headers: req.headers,
			body: req.body,
			/* Required when `body` is a stream — see module docblock. */
			// @ts-expect-error - `duplex` not in TS DOM lib yet
			duplex: "half",
		});
	} catch (err) {
		log.error("[mcp] failed to synthesize auth-router request", err);
		return new Response(null, { status: 503 });
	}
	const auth = await getAuth();
	return auth.handler(authReq);
};

/**
 * `mcp-handler`'s streamable-HTTP transport routes JSON-RPC over POST
 * and rejects GET / DELETE with 405 Method Not Allowed before any tool
 * dispatch. The shim is wired into all three Next route exports anyway
 * so token + scope verification + rate limiting run uniformly — a
 * verified-but-405 response shape is the right behavior for verbs
 * Nova doesn't speak.
 */
export { dispatch as DELETE, dispatch as GET, dispatch as POST };
