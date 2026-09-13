import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
	CREATION_IDENTITY_SPECS,
	type CreationIdentitySpec,
} from "@/lib/agent/change-set/creationIdentities";
import {
	computeFieldPath,
	findContainingForm,
} from "@/lib/doc/mutations/helpers";
import {
	type BlueprintDoc,
	type FieldKind,
	fieldKinds,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import type { NamedAuthoringField } from "./bindings";
import { AuthoringInputError } from "./errors";

type Input = Record<string, unknown>;
const object = z.record(z.string(), z.unknown());

/** Reuse the existing closed creation inventory. Targets and anchors never mint
 * identities; replacements may ask their owning collection for an existing id. */
export function allocateCreationIdentities(
	toolName: string,
	input: Input,
	preserve?: (
		spec: CreationIdentitySpec,
		item: Input,
		path: readonly (string | number)[],
	) => Uuid | undefined,
) {
	const allocations: {
		uuid: Uuid;
		kind: CreationIdentitySpec["entityKind"];
		path: readonly (string | number)[];
	}[] = [];
	for (const spec of CREATION_IDENTITY_SPECS[toolName] ?? []) {
		function visit(
			value: unknown,
			offset: number,
			path: readonly (string | number)[],
		) {
			const segment = spec.path[offset];
			if (segment === "*") {
				if (Array.isArray(value))
					for (const [index, item] of value.entries())
						visit(item, offset + 1, [...path, index]);
				return;
			}
			if (value === null || typeof value !== "object" || Array.isArray(value))
				return;
			const item = value as Input;
			if (offset < spec.path.length - 1) {
				visit(item[segment], offset + 1, [...path, segment]);
				return;
			}
			if (item[segment] !== undefined) return;
			const uuid =
				(spec.referenceIfBound && preserve?.(spec, item, path)) ||
				uuidSchema.parse(randomUUID());
			item[segment] = uuid;
			allocations.push({
				uuid,
				kind: spec.entityKind,
				path: [...path, segment],
			});
		}
		visit(input, 0, []);
	}
	return allocations;
}

interface FieldName {
	uuid: Uuid;
	id: string;
	kind: FieldKind;
	parent: string;
	input?: Input;
}

/** Complete form names for one call. Parent names can point forward in the
 * same batch. Nothing here constructs or changes a Blueprint document. */
export function prepareFormNames(args: {
	doc: BlueprintDoc;
	formUuid: Uuid;
	fields?: readonly unknown[];
	parent?: string;
	edit?: { uuid: Uuid; id?: string; kind?: FieldKind };
}): { names: readonly NamedAuthoringField[]; fields: readonly Input[] } {
	const { doc, formUuid } = args;
	const fields: FieldName[] = Object.values(doc.fields)
		.filter((field) => findContainingForm(doc, field.uuid) === formUuid)
		.map((field) => ({
			uuid: field.uuid,
			id: field.id,
			kind: field.kind,
			parent: doc.fieldParent[field.uuid] ?? formUuid,
		}));
	const original: NamedAuthoringField[] = [];
	for (const field of fields) {
		const path = computeFieldPath(doc, field.uuid);
		if (!path)
			throw new AuthoringInputError(
				`Field ${field.id} has no path in this form.`,
			);
		original.push({ uuid: field.uuid, path, kind: field.kind });
	}
	for (const raw of args.fields ?? []) {
		const input = object.parse(raw);
		// The caller already allocated every creation identity once. Read the
		// original object so replacing parent names reaches canonical input.
		if (raw === null || typeof raw !== "object" || Array.isArray(raw))
			throw new AuthoringInputError("A field must be an object.");
		fields.push({
			uuid: uuidSchema.parse(input.fieldUuid),
			id: z.string().parse(input.id),
			kind: z.enum(fieldKinds).parse(input.kind),
			parent: z.string().parse(input.parentUuid ?? args.parent ?? formUuid),
			input: raw as Input,
		});
	}
	if (args.edit) {
		const field = fields.find((field) => field.uuid === args.edit?.uuid);
		if (!field)
			throw new AuthoringInputError("The edited field is not in this form.");
		if (args.edit.id !== undefined) field.id = args.edit.id;
		if (args.edit.kind !== undefined) field.kind = args.edit.kind;
	}
	const byId = new Map<string, FieldName>(
		fields.map((field) => [field.uuid, field]),
	);
	if (byId.size !== fields.length)
		throw new AuthoringInputError(
			"A field identity appears more than once in this form.",
		);
	const paths = new Map<Uuid, string>();
	const visiting = new Set<Uuid>();
	function path(field: FieldName): string {
		const known = paths.get(field.uuid);
		if (known !== undefined) return known;
		if (visiting.has(field.uuid))
			throw new AuthoringInputError(`Field ${field.id} has cyclic parents.`);
		visiting.add(field.uuid);
		try {
			let parent: FieldName | undefined;
			if (field.parent !== formUuid) {
				parent = byId.get(field.parent);
				if (!parent) {
					const name = field.parent;
					const candidates = fields.filter(
						(candidate) =>
							candidate.uuid !== field.uuid &&
							["group", "repeat", "section"].includes(candidate.kind) &&
							candidate.id === name.split("/").at(-1),
					);
					const exact = candidates.filter((candidate) =>
						matchesPath(candidate, name),
					);
					const matches =
						exact.length || name.includes("/") ? exact : candidates;
					if (matches.length !== 1)
						throw new AuthoringInputError(
							`Parent ${name} is missing or ambiguous in this form.`,
						);
					parent = matches[0];
				}
				if (!["group", "repeat", "section"].includes(parent.kind))
					throw new AuthoringInputError(
						`Parent ${parent.id} is not a group, repeat, or section.`,
					);
				field.parent = parent.uuid;
				if (field.input) field.input.parentUuid = parent.uuid;
			}
			const result = parent ? `${path(parent)}/${field.id}` : field.id;
			paths.set(field.uuid, result);
			return result;
		} finally {
			visiting.delete(field.uuid);
		}
	}
	function matchesPath(candidate: FieldName, name: string): boolean {
		try {
			return path(candidate) === name;
		} catch (error) {
			// A candidate may depend on the field whose parent we are finding.
			// It cannot be that parent. Every field is resolved independently
			// below, so an actual invalid parent graph still rejects the batch.
			if (error instanceof AuthoringInputError) return false;
			throw error;
		}
	}
	const prepared = fields.map((field) => ({
		uuid: field.uuid,
		path: path(field),
		kind: field.kind,
	}));
	const additions = fields.filter((field) => field.input !== undefined);
	const addedIds = new Set<string>(additions.map((field) => field.uuid));
	const ordered: Input[] = [];
	function append(field: FieldName) {
		if (field.input) ordered.push(field.input);
		for (const child of additions.filter(
			(candidate) => candidate.parent === field.uuid,
		))
			append(child);
	}
	// Respect sibling order while emitting parents before their new children.
	for (const root of additions.filter((field) => !addedIds.has(field.parent)))
		append(root);
	return { names: [...original, ...prepared], fields: ordered };
}
