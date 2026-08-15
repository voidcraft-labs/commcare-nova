/**
 * Change-set-local handles — the private symbol table.
 *
 * A handle (`@name`) is an executor-local symbol bound ONCE to a
 * server-minted canonical UUID and entity kind, resolved STRUCTURALLY
 * before the original tool schema runs. Persisted steps hold only exact
 * canonical mutation JSON and UUIDs; handles never enter Blueprint state,
 * history, events, or any canonical surface.
 *
 * Resolution is total and structural: a handle reference is EXACTLY the
 * one-key object `{ "handle": "@name" }` — prose strings are never
 * searched, path/name/slug values are never interpreted, and a handle
 * object anywhere the resolved UUID cannot legally sit is caught by the
 * second parse through the original tool schema. No canonical tool schema
 * owns a `handle` property (a source test proves it), so the spelling is
 * collision-free by construction.
 */

import type { Uuid } from "@/lib/domain";
import { asUuid } from "@/lib/domain/uuid";
import { ChangeSetStagingRejectedError } from "./errors";
import {
	CHANGE_SET_HANDLE_PATTERN,
	type ChangeSetHandle,
	changeSetHandleSchema,
	type StagedEntityKind,
} from "./schemas";
import type { ChangeSetHandleBinding } from "./types";

/** One handle declared by a creation identity slot in raw executor input. */
export interface StagedHandleDeclaration {
	readonly handle: ChangeSetHandle;
	readonly entityKind: StagedEntityKind;
	/** A replacement slot may preserve a handle already bound to this kind or
	 *  bind it when the replacement creates a new nested entity. */
	readonly referenceIfBound?: boolean;
}

/** The in-memory binding table one workspace rehydrates from durable rows. */
export class HandleTable {
	private readonly byHandle = new Map<
		ChangeSetHandle,
		{ readonly uuid: Uuid; readonly entityKind: StagedEntityKind }
	>();
	private readonly boundUuids = new Set<string>();

	constructor(bindings: readonly ChangeSetHandleBinding[] = []) {
		for (const binding of bindings) {
			this.byHandle.set(binding.handle, {
				uuid: binding.uuid,
				entityKind: binding.entityKind,
			});
			this.boundUuids.add(binding.uuid);
		}
	}

	lookup(
		handle: ChangeSetHandle,
	):
		| { readonly uuid: Uuid; readonly entityKind: StagedEntityKind }
		| undefined {
		return this.byHandle.get(handle);
	}

	/**
	 * Bind one new handle to a freshly minted UUID. A handle already bound —
	 * to any kind — rejects: a handle cannot be rebound, reused for another
	 * kind, or shadowed.
	 */
	declare(handle: ChangeSetHandle, entityKind: StagedEntityKind): Uuid {
		const existing = this.byHandle.get(handle);
		if (existing !== undefined) {
			throw new ChangeSetStagingRejectedError(
				"HANDLE_RESOLUTION_FAILED",
				`Handle ${handle} is already bound to a ${existing.entityKind}; a handle binds once and cannot be redeclared.`,
			);
		}
		const uuid = asUuid(crypto.randomUUID());
		this.byHandle.set(handle, { uuid, entityKind });
		this.boundUuids.add(uuid);
		return uuid;
	}

	entries(): readonly (readonly [
		ChangeSetHandle,
		{ readonly uuid: Uuid; readonly entityKind: StagedEntityKind },
	])[] {
		return [...this.byHandle.entries()];
	}

	/** Keep only symbols whose authored identities still exist in the private
	 * candidate. Corrections may remove an entity created earlier in this same
	 * change set; its handle must disappear with it rather than poisoning the
	 * next slice's verified import. */
	retainingUuids(uuids: ReadonlySet<string>): HandleTable {
		const retained = new HandleTable();
		for (const [handle, binding] of this.byHandle.entries()) {
			if (!uuids.has(binding.uuid)) continue;
			retained.byHandle.set(handle, binding);
			retained.boundUuids.add(binding.uuid);
		}
		return retained;
	}

	/** A scratch copy for one invocation's tentative declarations — merged
	 *  back into workspace state only after the staged request commits. */
	clone(): HandleTable {
		const copy = new HandleTable();
		for (const [handle, binding] of this.byHandle.entries()) {
			copy.byHandle.set(handle, binding);
			copy.boundUuids.add(binding.uuid);
		}
		return copy;
	}
}

/** An exact one-key `{ handle: "@name" }` object, or null. A `handle` key
 *  beside other keys, or holding a non-handle value, is NOT a reference —
 *  the second schema parse decides what such an object means. */
export function asHandleRef(value: unknown): ChangeSetHandle | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const keys = Object.keys(value);
	if (keys.length !== 1 || keys[0] !== "handle") return null;
	const handle = (value as { handle: unknown }).handle;
	if (typeof handle !== "string" || !CHANGE_SET_HANDLE_PATTERN.test(handle)) {
		return null;
	}
	return changeSetHandleSchema.parse(handle);
}

export interface ResolvedHandleInput {
	readonly resolved: unknown;
	/** Every handle this input referenced, in first-seen order. */
	readonly used: readonly ChangeSetHandle[];
}

/**
 * Structurally replace every handle reference in one projected input with
 * its bound UUID. An unbound handle rejects — a reference cannot point to a
 * handle created by a later invocation.
 */
export function resolveHandleRefs(
	input: unknown,
	table: HandleTable,
): ResolvedHandleInput {
	const used: ChangeSetHandle[] = [];
	const seen = new Set<string>();
	const walk = (value: unknown): unknown => {
		const handle = asHandleRef(value);
		if (handle !== null) {
			const binding = table.lookup(handle);
			if (binding === undefined) {
				throw new ChangeSetStagingRejectedError(
					"HANDLE_RESOLUTION_FAILED",
					`Handle ${handle} is not bound in this change set. Declare it on the staging call that creates its entity, or use the entity's UUID.`,
				);
			}
			if (!seen.has(handle)) {
				seen.add(handle);
				used.push(handle);
			}
			return binding.uuid;
		}
		if (Array.isArray(value)) return value.map((entry) => walk(entry));
		if (typeof value === "object" && value !== null) {
			const out: Record<string, unknown> = {};
			for (const [key, entry] of Object.entries(value)) {
				out[key] = walk(entry);
			}
			return out;
		}
		return value;
	};
	return { resolved: walk(input), used };
}
