/**
 * Plain-English mapping of OAuth scopes to user-facing capabilities.
 * Single source of truth for `/consent` and the `/settings` connected-
 * apps popover; both surfaces must use `deriveCapabilities`.
 *
 * Capability rows under-list the raw OAuth `scope` set on purpose:
 *
 *   - **Implied scopes** (`openid`, `offline_access`) are protocol
 *     primitives, not user-facing permissions; listing them next to
 *     "Read your CommCare apps" implies they're comparable grants.
 *     Real OAuth consent UIs hide them; we do too.
 *   - **Overlapping scopes** collapse: `profile` + `email` → one
 *     "See your name and email" row, since splitting them implies
 *     granular control the flow doesn't actually offer.
 *
 * To add a capability, add it to `KNOWN_CAPABILITIES` AND add its
 * covering scope name(s) to `KNOWN_CAPABILITY_SCOPES`. Anything not
 * in either set falls through to a generic catch-all row, so the
 * user always sees every scope they're actually granting.
 */

import type { IconifyIcon } from "@iconify/types";
import tablerEye from "@iconify-icons/tabler/eye";
import tablerKey from "@iconify-icons/tabler/key";
import tablerPencil from "@iconify-icons/tabler/pencil";
import tablerUser from "@iconify-icons/tabler/user";

// ── Public types ────────────────────────────────────────────────────

/** Display row for a single capability the user is granting / has granted. */
export interface Capability {
	/** Stable React key. `nova.write` for Nova scopes, `identity` for the
	 *  collapsed OIDC row, `unknown:<scope>` for catch-all rows. */
	key: string;
	label: string;
	icon: IconifyIcon;
}

// ── Internal capability table ───────────────────────────────────────

interface CapabilityDef extends Capability {
	matches: (granted: ReadonlySet<string>) => boolean;
}

/**
 * The capabilities Nova advertises. The "on your behalf" on the write
 * row carries the trust signal for the most consequential grant — keep
 * it on rephrase.
 */
const KNOWN_CAPABILITIES: readonly CapabilityDef[] = [
	{
		key: "identity",
		label: "See your name and email",
		icon: tablerUser,
		matches: (s) => s.has("profile") || s.has("email"),
	},
	{
		key: "nova.read",
		label: "Read your CommCare apps",
		icon: tablerEye,
		matches: (s) => s.has("nova.read"),
	},
	{
		key: "nova.write",
		label: "Create, edit, and deploy CommCare apps on your behalf",
		icon: tablerPencil,
		matches: (s) => s.has("nova.write"),
	},
];

/**
 * Protocol scopes hidden from user-facing surfaces — `openid` is the
 * OIDC identity claim every flow includes, `offline_access` is just
 * refresh-token persistence. Neither is a permission the user is
 * meaningfully choosing to grant; see module docblock.
 */
const IMPLIED_SCOPES: ReadonlySet<string> = new Set([
	"openid",
	"offline_access",
]);

/** Scope names that a `KNOWN_CAPABILITIES` entry already covers. */
const KNOWN_CAPABILITY_SCOPES: ReadonlySet<string> = new Set([
	"profile",
	"email",
	"nova.read",
	"nova.write",
]);

// ── Public API ──────────────────────────────────────────────────────

/**
 * Translate raw scope strings into the capability rows the user
 * should see. Implied scopes drop out, overlapping scopes collapse,
 * unknown scopes fall through to a generic row so nothing the user
 * is granting can silently disappear.
 */
export function deriveCapabilities(scopes: readonly string[]): Capability[] {
	const granted = new Set(scopes);
	const rows: Capability[] = KNOWN_CAPABILITIES.filter((c) =>
		c.matches(granted),
	).map(({ key, label, icon }) => ({ key, label, icon }));

	for (const s of granted) {
		if (IMPLIED_SCOPES.has(s) || KNOWN_CAPABILITY_SCOPES.has(s)) continue;
		rows.push({
			key: `unknown:${s}`,
			label: `Access to ${s}`,
			icon: tablerKey,
		});
	}

	return rows;
}
