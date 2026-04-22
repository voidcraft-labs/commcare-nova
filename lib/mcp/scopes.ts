/**
 * OAuth scope constants + claim parsing for the MCP surface.
 *
 * Scope enforcement happens at the verify layer (the route handler
 * declares required scopes per tool-mount; an access token missing the
 * required scope is rejected before any adapter runs). This module
 * exposes the scope vocabulary and a small parser for the JWT's
 * space-separated `scope` claim.
 *
 * `nova.read` covers read-only operations and the dynamic-agent prompt
 * fetch used by the plugin skills. `nova.write` covers every mutation
 * and any operation that creates, deletes, or uploads an app.
 */

import type { JwtClaims } from "./types";

/**
 * Canonical scope identifiers. Using `as const` locks the object shape
 * so `Scope` below resolves to the literal union
 * `"nova.read" | "nova.write"` rather than `string`.
 */
export const SCOPES = {
	read: "nova.read",
	write: "nova.write",
} as const;

/**
 * Union of the scope string literals. Adapter registration sites and the
 * verify-layer config both reference this — the route handler's
 * `verifyAccessToken({ scopes })` accepts `Scope[]`, so a typo in a
 * required-scope list is a compile error rather than a silent grant.
 */
export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

/**
 * Parse the JWT's space-separated `scope` claim into an array of
 * tokens. Missing or whitespace-only claims return `[]`. Per RFC 8693
 * the claim is space-delimited; splitting on any whitespace run is
 * defensive against the occasional CR/LF an upstream token server emits.
 */
export function parseScopes(jwt: JwtClaims): string[] {
	return (jwt.scope ?? "").split(/\s+/).filter(Boolean);
}
