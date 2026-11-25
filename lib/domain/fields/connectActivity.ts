import tablerClipboardCheck from "@iconify-icons/tabler/clipboard-check";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import {
	editorSafeQuestionId,
	freeQuestionId,
	RESERVED_CONNECT_BLOCK_IDS,
} from "../questionId";
import { formLogicSchema, structuralFieldBase } from "./base";

/** PostgreSQL varchar(255) counts Unicode characters, including one per
 * supplementary character. Each activity creates or reuses a named unit. */
const unitName = z
	.string()
	.min(1)
	.refine((value) => [...value].length <= 255, {
		error: "A Connect activity name can have up to 255 characters.",
	});

export const connectActivitySchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("learning-module"),
		name: unitName,
		description: z.string(),
		// Vellum keeps leading zeroes in the hours cell. An ordinary numeric
		// edit has one spelling; a brought-in cell may carry another.
		estimatedHours: z.union([
			z.number().int().min(0).max(2147483647),
			z
				.string()
				.regex(/^0[0-9]+$/)
				.refine((text) => Number(text) <= 2147483647),
		]),
	}),
	z.strictObject({
		kind: z.literal("assessment"),
		score: formLogicSchema,
	}),
	z.strictObject({
		kind: z.literal("delivery"),
		name: unitName,
		/** Absence is the deliberate empty value in the submitted element. */
		entityId: formLogicSchema.optional(),
		entityName: formLogicSchema.optional(),
		workAreaId: formLogicSchema.optional(),
	}),
	z.strictObject({
		kind: z.literal("assigned-task"),
		name: unitName,
		description: z.string(),
	}),
]);

/** The node's question id is also its identity at the receiver. Its UUID
 * anchors placement and references within the app. The node appears in
 * the submission when it and its enclosing rows and groups are relevant. */
export const connectActivityFieldSchema = structuralFieldBase.extend({
	kind: z.literal("connect_activity"),
	activity: connectActivitySchema,
	relevant: formLogicSchema.optional(),
});

export type ConnectActivity = z.infer<typeof connectActivitySchema>;
export type ConnectActivityField = z.infer<typeof connectActivityFieldSchema>;

export const CONNECT_ROLES = ["learn", "deliver"] as const;
export type ConnectRole = (typeof CONNECT_ROLES)[number];

export function connectActivityRole(
	kind: ConnectActivity["kind"],
): ConnectRole {
	return kind === "learning-module" || kind === "assessment"
		? "learn"
		: "deliver";
}

export function missingConnectRoleMessage(
	id: string,
	role: ConnectRole,
): string {
	return `"${id}" uses the Connect ${role} role. You can enable that role or remove the activity.`;
}

/** Learning and task slugs use Django's default 50-character field. Delivery
 * units store 100. Assessments use the form's node id and store no slug. */
export const CONNECT_ID_MAX_LENGTH = 50;

export function connectActivityIdLimit(
	kind: ConnectActivity["kind"],
): number | undefined {
	if (kind === "assessment") return undefined;
	return kind === "delivery" ? 100 : CONNECT_ID_MAX_LENGTH;
}

/** A replacement ID must keep this activity within its receiver width and
 * share no data path with a sibling question. */
export function freeConnectId(
	id: string,
	taken: ReadonlySet<string>,
	kind: ConnectActivity["kind"],
): string {
	const limit = connectActivityIdLimit(kind);
	if (limit === undefined)
		return freeQuestionId(id, taken, RESERVED_CONNECT_BLOCK_IDS);
	const base = editorSafeQuestionId(id, RESERVED_CONNECT_BLOCK_IDS);
	const shortened = base.slice(0, limit);
	if (!taken.has(shortened)) return shortened;
	for (let n = 2; ; n++) {
		const suffix = `_${n}`;
		const replacement = base.slice(0, limit - suffix.length) + suffix;
		if (!taken.has(replacement)) return replacement;
	}
}

export const connectActivityFieldMetadata: FieldKindMetadata<"connect_activity"> =
	{
		kind: "connect_activity",
		xformKind: "data-only",
		dataType: "",
		icon: tablerClipboardCheck,
		label: "Connect activity",
		isStructural: false,
		isContainer: false,
		carriesValidation: false,
		saDocs:
			"Record a learning module, assessment, delivery or assigned task when its part of the form is submitted.",
		convertTargets: [],
	};
