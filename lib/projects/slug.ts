/**
 * Project slug derivation, shared by every Project-creating surface: the
 * header switcher (client) and the MCP `create_project` tool (server).
 *
 * Kept as a dependency-free leaf so the client bundle pays for nothing —
 * `crypto.randomUUID()` is a Web API available in both the browser and
 * Node. The random suffix is what makes two Projects of the same name
 * never collide on `auth_organization`'s unique slug; a caller that
 * still hits the unique constraint (a ~1-in-16M suffix collision)
 * retries with a fresh call rather than deriving determinism here.
 */

/** A URL-safe slug from a Project name plus a short random suffix so two
 *  Projects of the same name never collide on the org table's unique slug. */
export function slugForName(name: string): string {
	const base = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	const suffix = crypto.randomUUID().slice(0, 6);
	return base ? `${base}-${suffix}` : `project-${suffix}`;
}
