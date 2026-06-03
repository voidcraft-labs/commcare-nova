/**
 * Upload-target resolution — the single source of truth for "which project
 * space does this upload land in."
 *
 * A CommCare HQ API key can authorize multiple project spaces (an unscoped
 * key reaches every space its owner belongs to). So "the domain" is no longer
 * a property of the key — it's a choice among the spaces the key can reach.
 * This pure function makes that choice deterministic and identical across the
 * two surfaces that upload: the MCP `upload_app_to_hq` tool and the HTTP
 * `/api/commcare/upload` route. Keeping it pure (no I/O) is what lets it be
 * exhaustively unit-tested without touching Firestore or HQ.
 *
 * It is generic over any space with a `name`, deliberately NOT importing
 * CommCare's `CommCareDomain` — the resolver only ever matches on `name` and
 * returns the caller's own objects untouched, so it stays clear of the
 * `lib/commcare` emission boundary. Callers (which DO speak `CommCareDomain`)
 * get their concrete type back through the generic.
 *
 * The load-bearing rule: a multi-space key with no explicit request is
 * **ambiguous, never defaulted**. Silently picking the first space binds the
 * upload to the wrong space without telling the operator — the exact failure
 * this resolver exists to prevent. Callers turn `ambiguous` into an error that
 * names the spaces; they never paper over it. There is deliberately no stored
 * "default space": a multi-space key exists to operate across spaces, so the
 * target is a per-upload choice, never a remembered one.
 */

/** Minimal shape the resolver needs: anything identified by a `name`. */
export interface NamedSpace {
	name: string;
}

/**
 * Outcome of resolving an upload target, carrying the caller's own space type.
 *
 * - `ok` — exactly one space was determined; `domain` is it.
 * - `not_authorized` — the caller asked for a space the key can't reach;
 *   `available` lists the spaces it can, so the caller's message can be specific.
 * - `ambiguous` — no explicit ask and multiple reachable spaces; the caller
 *   must force a choice rather than guess. `available` lists the candidates.
 */
export type ResolveUploadDomainResult<T extends NamedSpace> =
	| { ok: true; domain: T }
	| { ok: false; reason: "not_authorized"; available: T[] }
	| { ok: false; reason: "ambiguous"; available: T[] };

/** Inputs to {@link resolveUploadDomain}. */
export interface ResolveUploadDomainArgs<T extends NamedSpace> {
	/** Every space the key can actually upload to (already access-probed). */
	availableDomains: T[];
	/** An explicit per-call/per-request space `name`. */
	requested?: string;
}

/**
 * Decide the upload target from the reachable set and an optional explicit
 * request.
 *
 * Precedence:
 *   1. An explicit `requested` space wins — it's `ok` if reachable, else
 *      `not_authorized` (a deliberate ask for an unreachable space is an
 *      error, not something to silently redirect).
 *   2. With no request and a single reachable space, that space is the answer
 *      (single-space keys upload with zero friction).
 *   3. Otherwise — multiple reachable spaces, no request — `ambiguous`. There
 *      is no stored default to fall back on by design; the caller forces a
 *      per-upload choice rather than guess.
 */
export function resolveUploadDomain<T extends NamedSpace>(
	args: ResolveUploadDomainArgs<T>,
): ResolveUploadDomainResult<T> {
	const { availableDomains } = args;
	/* Normalize: treat whitespace-only / empty requests as "no request" so a
	 * blank arg can't masquerade as a deliberate (and failing) ask. */
	const requested = args.requested?.trim() || undefined;

	if (requested) {
		const match = availableDomains.find((d) => d.name === requested);
		return match
			? { ok: true, domain: match }
			: { ok: false, reason: "not_authorized", available: availableDomains };
	}

	if (availableDomains.length === 1) {
		return { ok: true, domain: availableDomains[0] };
	}

	return { ok: false, reason: "ambiguous", available: availableDomains };
}
