import { z } from "zod";
import type { ConnectActivitySite } from "./connectActivitySites";
import { uuidSchema } from "./uuid";

const rowSchema = z.strictObject({
	repeat: uuidSchema,
	index: z.number().int().nonnegative(),
});
const occurrence = { fieldUuid: uuidSchema, rows: z.array(rowSchema) };
const learning = z.strictObject({
	...occurrence,
	kind: z.literal("learning-module"),
});
const assessment = z.strictObject({
	...occurrence,
	kind: z.literal("assessment"),
	score: z.string(),
});
const delivery = z.strictObject({
	...occurrence,
	kind: z.literal("delivery"),
	entityId: z.string(),
	entityName: z.string(),
	workAreaId: z.string(),
});
const task = z.strictObject({
	...occurrence,
	kind: z.literal("assigned-task"),
});
const occurrenceSchema = z.discriminatedUnion("kind", [
	learning,
	assessment,
	delivery,
	task,
]);
const id = z.string().min(1);
const named = { id, name: z.string().min(1) };
export const activityFactsSchema = z.array(
	z.discriminatedUnion("kind", [
		learning.extend(named),
		assessment.extend({ id }),
		delivery.extend(named),
		task.extend(named),
	]),
);
export type SubmittedActivity = z.infer<typeof occurrenceSchema>;
export type ActivityFact = SubmittedActivity & {
	readonly id: string;
	readonly name?: string;
};

/** Resolved against the form held by the submission's app-sequence fence. */
export interface ConnectSubmissionProgram {
	readonly sites: readonly ConnectActivitySite[];
	readonly occurrences: unknown;
}

/** Python int() accepts decimal digits in any script and an underscore between digits. */
function receiverScore(text: string): boolean {
	const value = text.trim();
	if (!/^[+-]?\p{Decimal_Number}(?:_?\p{Decimal_Number})*$/u.test(value))
		return false;
	let magnitude = 0;
	for (const character of value.replace(/^[+-]|_/g, "")) {
		const code = character.codePointAt(0);
		if (code === undefined) return false;
		let start = code;
		while (
			start > 0 &&
			/\p{Decimal_Number}/u.test(String.fromCodePoint(start - 1))
		)
			start--;
		magnitude = magnitude * 10 + ((code - start) % 10);
		if (magnitude > (value.startsWith("-") ? 2147483648 : 2147483647))
			return false;
	}
	return true;
}

/** Match Python UUID(value) for the string the delivery supplies. Keep the actual submitted spelling. */
function receiverAreaId(text: string): boolean {
	const hex = text
		.replaceAll("urn:", "")
		.replaceAll("uuid:", "")
		.replace(/^[{}]+|[{}]+$/g, "")
		.replaceAll("-", "");
	return /^[0-9a-fA-F]{32}$/.test(hex);
}

export function submittedActivityFacts(
	program: ConnectSubmissionProgram,
): { readonly facts: ActivityFact[] } | { readonly issue: string } {
	const parsed = z.array(occurrenceSchema).safeParse(program.occurrences);
	if (!parsed.success)
		return {
			issue:
				"The submitted activity answers are incomplete. Open the form again to submit its current activities.",
		};
	const sites = new Map(program.sites.map((site) => [site.field.uuid, site]));
	const positions = new Set<string>();
	const yielded = new Set<string>();
	const modules = new Set<string>();
	const deliveries = new Map<string, Set<string>>();
	let assessment = false;
	let task = false;
	const facts: ActivityFact[] = [];
	for (const item of parsed.data) {
		const site = sites.get(item.fieldUuid);
		if (
			!site ||
			item.kind !== site.field.activity.kind ||
			item.rows.length !== site.repeats.length ||
			item.rows.some((row, index) => row.repeat !== site.repeats[index])
		) {
			return {
				issue:
					"An activity's position has changed. Open the form again to submit its current activities.",
			};
		}
		const position = JSON.stringify([
			item.fieldUuid,
			...item.rows.map((row) => row.index),
		]);
		if (positions.has(position))
			return {
				issue:
					"This submission includes the same activity row twice. Open the form again to submit it once.",
			};
		positions.add(position);
		yielded.add(item.fieldUuid);
		const id = site.field.id;
		switch (item.kind) {
			case "learning-module":
				if (modules.has(id))
					return {
						issue: `The learning module "${id}" occurs more than once in this submission. Each completion needs its own submission.`,
					};
				modules.add(id);
				break;
			case "assessment":
				if (assessment)
					return {
						issue:
							"This submission includes two assessments. Each assessment needs its own submission.",
					};
				if (!receiverScore(item.score))
					return {
						issue:
							"The assessment score needs a whole number between −2147483648 and 2147483647.",
					};
				assessment = true;
				break;
			case "delivery": {
				const activity = site.field.activity;
				if (activity.kind !== "delivery")
					throw new Error("The Connect activity changed during submission.");
				if (
					(activity.entityId === undefined && item.entityId !== "") ||
					(activity.entityName === undefined && item.entityName !== "") ||
					(activity.workAreaId === undefined && item.workAreaId !== "")
				)
					return {
						issue: `The submission includes a value that "${id}" leaves blank. Open the form again to submit its current activities.`,
					};
				if (
					[...item.entityId].length > 255 ||
					[...item.entityName].length > 255
				)
					return {
						issue: `The person or place ID and name for "${id}" each have room for 255 characters.`,
					};
				if (item.workAreaId !== "" && !receiverAreaId(item.workAreaId))
					return { issue: `The work area for "${id}" needs its case ID.` };
				const entities = deliveries.get(id) ?? new Set();
				if (entities.has(item.entityId))
					return {
						issue: `Two deliveries of "${id}" have the same person or place ID. Use a distinct ID for each delivery in this submission.`,
					};
				entities.add(item.entityId);
				deliveries.set(id, entities);
				break;
			}
			case "assigned-task":
				task = true;
				break;
		}
		facts.push({
			...item,
			id,
			...("name" in site.field.activity
				? { name: site.field.activity.name }
				: {}),
		});
	}
	if (deliveries.size && task)
		return {
			issue:
				"The delivery and its assigned task need separate submissions. Complete the task first.",
		};
	for (const site of program.sites) {
		if (
			!site.repeats.length &&
			!site.guards.length &&
			!yielded.has(site.field.uuid)
		)
			return {
				issue: `This submission is missing the activity "${site.field.id}". Open the form again to submit its current activities.`,
			};
	}
	return { facts };
}
