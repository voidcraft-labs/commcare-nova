/** Immutable identity of ordinary private work, supplied by its authenticated
 * host. The owning service reauthorizes this identity inside its transaction;
 * these identifiers alone are never a permission grant. */
export type OrdinaryAuthoringAuthority = { readonly sessionId: string } & (
	| { readonly origin: "mcp" }
	| { readonly origin: "chat"; readonly threadId: string }
);
