/**
 * Handle declarations on the SHARED structural creation tools.
 *
 * The executor wire widens reference slots to `uuid | { handle }` and narrows
 * creation slots to `{ handle }`. A creation slot must bind that handle before
 * the workspace resolves the complete input through the original canonical
 * schema. Every declarer here is DERIVED from the one annotated table in
 * `creationIdentities.ts` — the same table the wire projection narrows from —
 * so a slot the wire requires a handle for is always a slot the workspace
 * binds, and target, parent, and anchor slots never accidentally mint an
 * entity.
 */

import {
	CREATION_IDENTITY_SPECS,
	collectCreationHandleDeclarations,
} from "./creationIdentities";
import type { StagedHandleDeclaration } from "./handles";

type HandleDeclarer = (input: unknown) => readonly StagedHandleDeclaration[];

/* One stable function per tool: the registry exposes these by identity, so a
 * fresh closure per lookup would break `declaredHandles === declarer`. */
const DECLARERS: ReadonlyMap<string, HandleDeclarer> = new Map(
	Object.keys(CREATION_IDENTITY_SPECS).map((toolName) => [
		toolName,
		(input: unknown) => collectCreationHandleDeclarations(toolName, input),
	]),
);

/** The declaration reader for one tool, if that tool creates a
 * handle-capable structural identity. */
export function sharedHandleDeclarer(
	toolName: string,
): HandleDeclarer | undefined {
	return DECLARERS.get(toolName);
}
