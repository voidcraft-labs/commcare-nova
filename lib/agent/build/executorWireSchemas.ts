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
 * lookup, location-row, and worker identities stay canonical:
 * they exist outside the private candidate, so offering a handle there would
 * only teach the model to write a reference that cannot resolve.
 *
 * The projected schema is for the PROVIDER and SDK-side shape. The executor
 * independently refuses any creation slot that is missing a handle before
 * dispatch; `stageDispatch` then binds declarations, resolves `{ handle }`
 * structurally, and re-parses the resolved input through the tool's ORIGINAL
 * Zod schema. An unbound handle, a handle in an illegal slot, or a handle of
 * the wrong entity kind rejects at that shared boundary.
 */

import type { JSONSchema7 } from "@ai-sdk/provider";
import type { z } from "zod";
import { creationIdentityPaths } from "@/lib/agent/change-set/creationIdentities";
import { CHANGE_SET_HANDLE_PATTERN } from "@/lib/agent/change-set/schemas";
import { familyIsHandleEligible } from "@/lib/agent/change-set/stagingProjection";
import { collectIdentitySchemaPointers } from "@/lib/agent/identityPointerRegistry";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { wireToolSchema } from "@/lib/agent/wireSchemas";
import type { BlueprintDoc } from "@/lib/domain";
import { LOOKUP_UUID_V7_PATTERN } from "@/lib/domain/lookupIds";
import { CANONICAL_UUID_PATTERN } from "@/lib/domain/uuid";

/** The `{ handle }` arm every widened slot gains. */
const HANDLE_REF_SCHEMA = {
	type: "object",
	properties: {
		handle: { type: "string", pattern: CHANGE_SET_HANDLE_PATTERN.source },
	},
	required: ["handle"],
	additionalProperties: false,
	description:
		"A durable handle for an entity created earlier in this accepted plan or privately in this change set.",
} as const satisfies JSONSchema7;

const EXISTING_LOOKUP_REFERENCE_SCHEMA = {
	type: "object",
	properties: {
		kind: { const: "existing-project-lookup" },
		tableId: { type: "string", pattern: LOOKUP_UUID_V7_PATTERN.source },
		valueColumnId: { type: "string", pattern: LOOKUP_UUID_V7_PATTERN.source },
		labelColumnId: { type: "string", pattern: LOOKUP_UUID_V7_PATTERN.source },
	},
	required: ["kind", "tableId", "valueColumnId", "labelColumnId"],
	additionalProperties: false,
	description:
		"The exact accepted reference to an existing Project lookup source. Copy it unchanged from the execution brief.",
} as const satisfies JSONSchema7;

const DESIGNED_LOOKUP_REFERENCE_SCHEMA = {
	type: "object",
	properties: {
		kind: { const: "designed-project-lookup" },
		tableId: { type: "string", pattern: CANONICAL_UUID_PATTERN.source },
		valueColumnId: { type: "string", pattern: CANONICAL_UUID_PATTERN.source },
		labelColumnId: { type: "string", pattern: CANONICAL_UUID_PATTERN.source },
	},
	required: ["kind", "tableId", "valueColumnId", "labelColumnId"],
	additionalProperties: false,
	description:
		"The exact accepted reference to a lookup source created by this design. Copy it unchanged from the execution brief; Nova resolves it privately.",
} as const satisfies JSONSchema7;

type IdentityPath = readonly string[];

/* Every raw slot that CREATES an authorable identity on the private executor
 * surface lives in ONE annotated table — `creationIdentities.ts` — which the
 * handle declarers also derive from, so a slot this projection narrows to a
 * required handle is always a slot the workspace binds. Reference slots
 * remain `uuid | { handle }`; creation slots narrow to a required handle so
 * the executor can never fall back to a server-minted UUID that has no
 * durable symbol. */

function schemaVariants(value: unknown): Record<string, unknown>[] {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return [];
	}
	const node = value as Record<string, unknown>;
	return [
		node,
		...["anyOf", "oneOf", "allOf"].flatMap((key) => {
			const arms = node[key];
			return Array.isArray(arms) ? arms.flatMap(schemaVariants) : [];
		}),
	];
}

function canonicalLookupSourceArm(node: Record<string, unknown>): boolean {
	const properties = node.properties;
	if (
		properties === null ||
		typeof properties !== "object" ||
		Array.isArray(properties)
	)
		return false;
	const slots = properties as Record<string, unknown>;
	const kind = slots.kind;
	return (
		kind !== null &&
		typeof kind === "object" &&
		!Array.isArray(kind) &&
		(kind as Record<string, unknown>).const === "lookup" &&
		"tableId" in slots &&
		"valueColumnId" in slots &&
		"labelColumnId" in slots
	);
}

/** The compiler model keeps accepted semantic lookup references. Replace the
 * ordinary canonical carrier arm on its private wire only; the shared tool's
 * original Zod schema remains the final parser after the workspace resolves
 * the reference behind the server boundary. */
function projectAcceptedLookupReferenceArms(value: unknown): number {
	if (value === null || typeof value !== "object") return 0;
	if (Array.isArray(value))
		return value.reduce(
			(count, member) => count + projectAcceptedLookupReferenceArms(member),
			0,
		);
	const node = value as Record<string, unknown>;
	if (canonicalLookupSourceArm(node)) {
		for (const key of Object.keys(node)) delete node[key];
		node.anyOf = [
			structuredClone(EXISTING_LOOKUP_REFERENCE_SCHEMA),
			structuredClone(DESIGNED_LOOKUP_REFERENCE_SCHEMA),
		];
		return 1;
	}
	return Object.values(node).reduce<number>(
		(count, member) => count + projectAcceptedLookupReferenceArms(member),
		0,
	);
}

function narrowSchemaCreationPath(
	nodes: readonly unknown[],
	path: IdentityPath,
	index = 0,
): number {
	const segment = path[index];
	if (segment === undefined) return 0;
	if (segment === "*") {
		return narrowSchemaCreationPath(
			nodes.flatMap((node) =>
				schemaVariants(node).flatMap((variant) =>
					variant.items === undefined ? [] : [variant.items],
				),
			),
			path,
			index + 1,
		);
	}
	let changed = 0;
	const children: unknown[] = [];
	for (const node of nodes) {
		for (const variant of schemaVariants(node)) {
			const properties = variant.properties;
			if (
				properties === null ||
				typeof properties !== "object" ||
				Array.isArray(properties)
			)
				continue;
			const slots = properties as Record<string, unknown>;
			if (!(segment in slots)) continue;
			if (index === path.length - 1) {
				slots[segment] = structuredClone(HANDLE_REF_SCHEMA);
				const required = Array.isArray(variant.required)
					? variant.required.filter(
							(entry): entry is string => typeof entry === "string",
						)
					: [];
				variant.required = [...new Set([...required, segment])];
				changed += 1;
			} else {
				children.push(slots[segment]);
			}
		}
	}
	return index === path.length - 1
		? changed
		: narrowSchemaCreationPath(children, path, index + 1);
}

function hasExactHandle(value: unknown): boolean {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === 1 &&
		typeof (value as { handle?: unknown }).handle === "string" &&
		CHANGE_SET_HANDLE_PATTERN.test((value as { handle: string }).handle)
	);
}

function rawCreationPathIssue(
	value: unknown,
	path: IdentityPath,
	index = 0,
	label = "input",
): string | null {
	const segment = path[index];
	if (segment === undefined) return null;
	if (segment === "*") {
		if (!Array.isArray(value)) return null;
		for (const [itemIndex, item] of value.entries()) {
			const issue = rawCreationPathIssue(
				item,
				path,
				index + 1,
				`${label}.${itemIndex}`,
			);
			if (issue !== null) return issue;
		}
		return null;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const member = (value as Record<string, unknown>)[segment];
	const memberLabel = `${label}.${segment}`;
	if (index === path.length - 1) {
		return hasExactHandle(member)
			? null
			: `${memberLabel} must declare a durable handle.`;
	}
	if (member === undefined || member === null) return null;
	return rawCreationPathIssue(member, path, index + 1, memberLabel);
}

/** Runtime counterpart to the provider projection. AI SDK forwards a raw
 * JSON Schema without a validator, so the executor must independently refuse
 * any creation that could mint an unbound identity before dispatch. */
export function executorCreationHandleIssue(
	toolName: string,
	input: unknown,
): string | null {
	for (const path of creationIdentityPaths(toolName)) {
		const issue = rawCreationPathIssue(input, path);
		if (issue !== null) return issue;
	}
	return null;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function creationFields(toolName: string, input: unknown): readonly unknown[] {
	const root = record(input);
	if (root === null) return [];
	if (toolName === "addFields" || toolName === "createForm") {
		return Array.isArray(root.fields) ? root.fields : [];
	}
	if (toolName !== "createModule" || !Array.isArray(root.forms)) return [];
	return root.forms.flatMap((formValue) => {
		const form = record(formValue);
		return Array.isArray(form?.fields) ? form.fields : [];
	});
}

/** Catalog defaults are normally ergonomic, but a select default mints
 * authorable option identities after raw handle declaration. The executor
 * therefore requires the same inline options explicitly, with handled
 * `optionUuid` slots, before the shared creator runs. */
export function executorCatalogDefaultHandleIssue(
	toolName: string,
	input: unknown,
	doc: BlueprintDoc,
): string | null {
	for (const [index, fieldValue] of creationFields(toolName, input).entries()) {
		const field = record(fieldValue);
		if (
			field === null ||
			(field.optionsSource !== undefined && field.optionsSource !== null) ||
			(field.kind !== undefined &&
				field.kind !== null &&
				field.kind !== "single_select" &&
				field.kind !== "multi_select")
		) {
			continue;
		}
		const caseWrite = record(field.caseWrite);
		if (
			typeof caseWrite?.caseType !== "string" ||
			typeof caseWrite.property !== "string"
		) {
			continue;
		}
		const property = doc.caseTypes
			?.find((caseType) => caseType.name === caseWrite.caseType)
			?.properties.find((entry) => entry.name === caseWrite.property);
		if ((property?.options?.length ?? 0) === 0) continue;
		return `input field ${index} writes select property ${caseWrite.caseType}.${caseWrite.property}; pass its catalog options as an explicit inline optionsSource and give every optionUuid a durable handle.`;
	}
	return null;
}

const MCP_NAME_BY_SA_NAME: ReadonlyMap<string, string> = new Map(
	SHARED_TOOL_REGISTRY.map((entry) => [entry.saName, entry.mcpName]),
);

function unescapePointerToken(token: string): string {
	return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Collect every uuid-shaped identity slot whose family may carry a handle,
 *  as JSON pointers into `json`. */
function handleEligiblePointers(
	toolName: string,
	json: JSONSchema7,
): readonly string[] {
	const mcpName = MCP_NAME_BY_SA_NAME.get(toolName);
	if (mcpName !== undefined) {
		return collectIdentitySchemaPointers(
			mcpName,
			json as unknown as Record<string, unknown>,
		)
			.filter((pointer) => familyIsHandleEligible(pointer.family))
			.map((pointer) => pointer.schemaPointer);
	}
	/* The loop's own server tools address no Blueprint identities. */
	return [];
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
): JSONSchema7 {
	const source = wireToolSchema(zodSchema).jsonSchema;
	if (typeof source !== "object" || source === null) {
		throw new Error(
			`The tool ${name} projected to a non-object JSON schema, which cannot carry identity slots. Every executor tool takes an object input.`,
		);
	}
	const projected = structuredClone(source) as JSONSchema7;
	projectAcceptedLookupReferenceArms(projected);
	for (const pointer of handleEligiblePointers(name, projected)) {
		widenAtPointer(projected, pointer);
	}
	for (const path of creationIdentityPaths(name)) {
		if (narrowSchemaCreationPath([projected], path) === 0) {
			throw new Error(
				`The executor cannot find canonical creation identity ${name}.${path.join(".")}.`,
			);
		}
	}
	return projected;
}
