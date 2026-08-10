/**
 * The executor's provider-facing tool schemas — the same compact wire
 * projection chat sends (`lib/agent/wireSchemas.ts`), widened so a
 * handle-eligible identity slot also accepts `{ "handle": "@name" }`.
 *
 * WHICH slots widen is not "every uuid-shaped string": it is exactly the
 * reviewed classification in
 * `lib/agent/change-set/stagingProjection.ts::STAGING_PROJECTION_DECISIONS`,
 * resolved per slot through the shared identity-pointer registry. Only
 * Blueprint-ENTITY families are handle-eligible — a change set can create
 * those privately, so a symbol for one is meaningful. App, Project, media,
 * lookup, location-row, worker, and automation identities stay canonical:
 * they exist outside the private candidate, so offering a handle there would
 * only teach the model to write a reference that cannot resolve.
 *
 * The widened schema is for the PROVIDER and the SDK-side shape only. The
 * gate is unchanged and lives where it always did: `stageDispatch` resolves
 * `{ handle }` STRUCTURALLY and then re-parses the resolved input through the
 * tool's ORIGINAL Zod schema, so an unbound handle, a handle in an illegal
 * slot, or a handle of the wrong entity kind rejects there exactly as before.
 */

import type { JSONSchema7 } from "@ai-sdk/provider";
import type { z } from "zod";
import { CHANGE_SET_TOOL_REGISTRY } from "@/lib/agent/change-set/registry";
import { CHANGE_SET_HANDLE_PATTERN } from "@/lib/agent/change-set/schemas";
import { familyIsHandleEligible } from "@/lib/agent/change-set/stagingProjection";
import {
	type AuthorableIdentityFamily,
	collectIdentitySchemaPointers,
} from "@/lib/agent/identityPointerRegistry";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { wireToolSchema } from "@/lib/agent/wireSchemas";

/**
 * The complete mounted executor tool surface.
 *
 * `discardChangeSet` is deliberately absent: discarding a slice's private work
 * is an orchestrator or user decision (retry policy, supersession), never a
 * move the executor can make to escape its own diagnostics.
 */
export const EXECUTOR_TOOL_SURFACE: readonly string[] = [
	...Array.from(CHANGE_SET_TOOL_REGISTRY.values())
		.filter((entry) => entry.policy.effect === "read-blueprint")
		.map((entry) => entry.name),
	"stageBatch",
	"inspectChangeSet",
	"commitChangeSet",
	"reportExecutionBlocker",
];

/** The `{ handle }` arm every widened slot gains. */
const HANDLE_REF_SCHEMA = {
	type: "object",
	properties: {
		handle: { type: "string", pattern: CHANGE_SET_HANDLE_PATTERN.source },
	},
	required: ["handle"],
	additionalProperties: false,
	description:
		"A change-set handle for an entity created privately in this change set.",
} as const satisfies JSONSchema7;

const MCP_NAME_BY_SA_NAME: ReadonlyMap<string, string> = new Map(
	SHARED_TOOL_REGISTRY.map((entry) => [entry.saName, entry.mcpName]),
);

/**
 * The executor-only staging tools are not in the shared registry, so the
 * shared classifier has no rule for their slots. Their identity families are
 * declared here, by property name — the same reviewed act as adding a rule to
 * `identityPointerRegistry.ts::classifyIdentity`, kept beside the only surface
 * that mounts them.
 *
 * `after` is a sequence anchor: on `stageModule` it names the module the new
 * module follows, on `stageForm` the form it follows inside the module.
 */
const STAGE_TOOL_IDENTITY_FAMILIES: Readonly<
	Record<string, Readonly<Record<string, AuthorableIdentityFamily>>>
> = {
	stageModule: { moduleUuid: "module", after: "module" },
	stageForm: { formUuid: "form", moduleUuid: "module", after: "form" },
};

function unescapePointerToken(token: string): string {
	return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Collect every uuid-shaped identity slot whose family may carry a handle,
 *  as JSON pointers into `json`. */
function handleEligiblePointers(
	toolName: string,
	json: JSONSchema7,
	additionalFamilies: ReadonlySet<AuthorableIdentityFamily>,
): readonly string[] {
	const mcpName = MCP_NAME_BY_SA_NAME.get(toolName);
	if (mcpName !== undefined) {
		return collectIdentitySchemaPointers(
			mcpName,
			json as unknown as Record<string, unknown>,
		)
			.filter(
				(pointer) =>
					familyIsHandleEligible(pointer.family) ||
					additionalFamilies.has(pointer.family),
			)
			.map((pointer) => pointer.schemaPointer);
	}
	const declared = STAGE_TOOL_IDENTITY_FAMILIES[toolName];
	/* Not a shared tool and not an executor staging tool — the loop's own
	 * server-owned tools (inspect/commit/raise). They address nothing a change
	 * set creates, so nothing widens. */
	if (declared === undefined) return [];
	const pointers: string[] = [];
	for (const [property, family] of Object.entries(declared)) {
		if (!familyIsHandleEligible(family)) continue;
		const slot = (json.properties as Record<string, unknown> | undefined)?.[
			property
		];
		if (slot === undefined) continue;
		/* `uuidSchema.nullable()` emits an `anyOf` of the string and null; widen
		 * the string arm, never the null. */
		const arms = (slot as { anyOf?: unknown[] }).anyOf;
		if (Array.isArray(arms)) {
			arms.forEach((arm, index) => {
				if ((arm as { type?: unknown }).type === "string") {
					pointers.push(`/properties/${property}/anyOf/${index}`);
				}
			});
			continue;
		}
		pointers.push(`/properties/${property}`);
	}
	return pointers;
}

/** Replace the node at one JSON pointer with `original | { handle }`. */
function widenAtPointer(root: JSONSchema7, pointer: string): void {
	const tokens = pointer.split("/").slice(1).map(unescapePointerToken);
	const key = tokens.pop();
	if (key === undefined) return;
	let parent: unknown = root;
	for (const token of tokens) {
		if (parent === null || typeof parent !== "object") return;
		parent = (parent as Record<string, unknown>)[token];
	}
	if (parent === null || typeof parent !== "object") return;
	const container = parent as Record<string, unknown>;
	const original = container[key];
	if (original === undefined) return;
	container[key] = { anyOf: [original, HANDLE_REF_SCHEMA] };
}

/**
 * The provider-facing JSON schema for one executor tool.
 *
 * Starts from the exact projection chat sends — the executor and the chat SA
 * read one grammar, so the two surfaces cannot drift — then widens the
 * handle-eligible identity slots. The projection is cached and shared, so the
 * clone is load-bearing: widening must never mutate what chat sends.
 */
export function executorWireToolSchema(
	name: string,
	zodSchema: z.ZodType,
	options?: {
		readonly additionalHandleFamilies?: readonly AuthorableIdentityFamily[];
	},
): JSONSchema7 {
	const source = wireToolSchema(zodSchema).jsonSchema;
	if (typeof source !== "object" || source === null) {
		throw new Error(
			`The tool ${name} projected to a non-object JSON schema, which cannot carry identity slots. Every executor tool takes an object input.`,
		);
	}
	const projected = structuredClone(source) as JSONSchema7;
	const additionalFamilies = new Set(options?.additionalHandleFamilies ?? []);
	for (const pointer of handleEligiblePointers(
		name,
		projected,
		additionalFamilies,
	)) {
		widenAtPointer(projected, pointer);
	}
	return projected;
}
