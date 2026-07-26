import type { LookupFailure } from "@/lib/lookup/types";

/**
 * A Project-scoped read's state. `idle` means there is nothing authorized to
 * read yet; it is deliberately distinct from an in-flight server request.
 */
export type ProjectDataRead<Value> =
	| { readonly kind: "idle" }
	| { readonly kind: "loading" }
	| { readonly kind: "data"; readonly value: Value }
	| { readonly kind: "failed"; readonly failure: LookupFailure };

/** Internal resource state. Every settled or transitional value owns the
 * Project/table identity that produced it, including failures and loading. */
export type ScopedProjectDataRead<Value> = ProjectDataRead<Value> & {
	readonly resourceIdentity: string;
};

export function scopeProjectDataRead<Value>(
	resourceIdentity: string,
	read: ProjectDataRead<Value>,
): ScopedProjectDataRead<Value> {
	return { ...read, resourceIdentity };
}

const IDLE: ProjectDataRead<never> = { kind: "idle" };
const LOADING: ProjectDataRead<never> = { kind: "loading" };

/**
 * Synchronous render-time identity fence.
 *
 * A dependency effect cannot mask state until after React has painted the new
 * URL. This projection refuses to expose a resource whose owner differs from
 * the current route, so direct navigation and browser history can never render
 * table A's snapshot (or failure) under table B's identity for one frame.
 */
export function projectDataReadForIdentity<Value>(args: {
	readonly read: ScopedProjectDataRead<Value>;
	readonly resourceIdentity: string;
	readonly ready: boolean;
}): ProjectDataRead<Value> {
	if (args.read.resourceIdentity === args.resourceIdentity) return args.read;
	return args.ready ? LOADING : IDLE;
}
