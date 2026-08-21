/**
 * SA tool: `setFormSections` — split a form into sections (pages), re-page
 * it, or return it to a single page, in ONE call.
 *
 * A section is a page of a form: on a phone each one is a screen of its own,
 * with Next checking that screen before moving on. Once a form has a
 * section, every top-level question belongs inside one — the commit gate
 * judges the partition as a whole (`FORM_SECTIONS_INCOMPLETE` refuses every
 * half-way shape), so a model issuing `addFields` + N `moveField` calls could
 * never get there one call at a time. This tool takes the DESIRED partition
 * instead: the complete list of pages, each naming its top-level questions in
 * order. It is also how a model re-pages an EXISTING form without reciting
 * moves it cannot see — the same "one act or a dead end" argument
 * `setCaseListTile` records.
 *
 * The planner (`lib/doc/formSectionMutations.ts::setFormSections`) turns the
 * partition into the minimal batch of ordinary field mutations: kept sections
 * (named by `sectionUuid`) keep their identity and, unless the call says
 * otherwise, their title; unnamed sections are created; current sections left
 * out are removed once their questions have moved; an empty list returns the
 * form to a single page. Every refusal is the planner's own sentence, so the
 * builder and this tool say one thing.
 *
 * Both the SA chat factory and the MCP adapter call this through the shared
 * `ToolInvocationContext` interface. Four exit branches:
 *
 *   1. Module / form UUID address does not resolve → `{ error }`, no mutations.
 *   2. The partition is not one (a question missing, named twice, nested, or
 *      foreign; a foreign or repeated section uuid; an add-entries repeat on a
 *      page) → `{ error }`, no mutations.
 *   3. The form is already arranged this way → success with nothing persisted.
 *   4. Success → `{ message, sections, summary }` plus the persisted mutations,
 *      tagged `form:F`.
 */

import { z } from "zod";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import {
	type DesiredSection,
	setFormSections,
} from "@/lib/doc/formSectionMutations";
import { formSectionsOf } from "@/lib/doc/formSectionVerdicts";
import {
	asUuid,
	type BlueprintDoc,
	type ProseTemplate,
	proseTemplateSchema,
	proseTemplateText,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import type { ToolInvocationContext } from "../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import {
	formAddressSchema,
	resolveFormAddress,
} from "./shared/entityAddresses";
import type { MutationSuccess } from "./shared/toolCallSummary";

export const setFormSectionsInputSchema = formAddressSchema
	.extend({
		sections: z
			.array(
				z
					.object({
						sectionUuid: uuidSchema
							.optional()
							.describe(
								"An existing section to keep (its uuid from get_form), or a fresh uuid to create the page under when you need the handle before reading it back. Omit to let Nova mint one.",
							),
						label: proseTemplateSchema
							.nullable()
							.optional()
							.describe(
								"The page's title. null means untitled. Omit it to keep a kept section's current title; a new section without one is untitled.",
							),
						fields: z
							.array(uuidSchema)
							.describe(
								"The page's top-level questions, in page order: the form's root fields, or direct children of a current section. A group or repeat moves with everything inside it, so name the group, never a field inside it.",
							),
					})
					.strict(),
			)
			.describe(
				"The complete partition of the form's top-level questions into pages, first page first. Every top-level question appears in exactly one section. An empty list removes the sections and returns the questions to a single page in their current order.",
			),
	})
	.strict();

export type SetFormSectionsInput = z.infer<typeof setFormSectionsInputSchema>;

export interface SetFormSectionsSuccess extends MutationSuccess {
	/** The form's pages after the call, first page first. */
	sections: Array<{
		sectionUuid: Uuid;
		label: ProseTemplate | null;
		fieldUuids: Uuid[];
	}>;
}

export type SetFormSectionsResult = SetFormSectionsSuccess | { error: string };

export const setFormSectionsTool = {
	description:
		"Split a form into sections (pages), re-page it, or return it to a single page, in one call. Pass the complete partition of the form's top-level questions into pages, first page first: name an existing section by sectionUuid to keep it, leave sectionUuid out to create one, and leave a current section out to remove it once its questions have moved. Every top-level question must land on exactly one page; an empty list removes all sections. A worker-added (user_controlled) repeat cannot sit on a page; fixed-count and case-query repeats can.",
	inputSchema: setFormSectionsInputSchema,
	async execute(
		input: SetFormSectionsInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<SetFormSectionsResult>> {
		const doc = ctx.snapshot.doc;
		try {
			const address = resolveFormAddress(doc, input);
			if (!address.ok) return errorResult(address.error);
			const { formUuid, form } = address;

			const desired: DesiredSection[] = input.sections.map((section) => ({
				...(section.sectionUuid !== undefined && {
					sectionUuid: asUuid(section.sectionUuid),
				}),
				...(section.label !== undefined && { label: section.label }),
				fields: section.fields.map(asUuid),
			}));

			const plan = setFormSections(doc, formUuid, desired);
			if (!plan.ok) return errorResult(plan.reason);

			if (plan.mutations.length === 0) {
				const sections = projectSections(doc, formUuid);
				return {
					kind: "mutate" as const,
					mutations: [],
					result: {
						message: `"${form.name}" is already arranged this way (${describeCount(sections.length)}); nothing changed.`,
						sections,
						summary: { location: form.name, count: sections.length },
					},
				};
			}

			const commit = await guardedMutate(
				ctx,
				plan.mutations,
				`form:${formUuid}`,
			);
			if (!commit.ok) return errorResult(commit.error);

			// Report against the COMMITTED doc: the guarded writer re-applies
			// onto fresh stored state, so a peer's concurrent edit is already
			// merged in and is what the SA continues against.
			const sections = projectSections(commit.newDoc, formUuid);
			const questionCount = sections.reduce(
				(n, section) => n + section.fieldUuids.length,
				0,
			);
			const message =
				sections.length === 0
					? `Removed the sections from "${form.name}"; its ${orderedFieldUuids(commit.newDoc, formUuid).length} top-level questions are on a single page again, in their previous order.`
					: `Arranged "${form.name}" into ${describeCount(sections.length)}: ${sections
							.map((section, index) => pageTitle(section.label, index))
							.join(
								", ",
							)}. ${questionCount} top-level ${questionCount === 1 ? "question sits" : "questions sit"} on those pages; getForm returns each section as a container with its questions as children.`;

			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					message,
					sections,
					summary: { location: form.name, count: sections.length },
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};

function errorResult(error: string): MutatingToolResult<SetFormSectionsResult> {
	return { kind: "mutate" as const, mutations: [], result: { error } };
}

function projectSections(
	doc: BlueprintDoc,
	formUuid: Uuid,
): SetFormSectionsSuccess["sections"] {
	return formSectionsOf(doc, formUuid).map((sectionUuid) => {
		const field = doc.fields[sectionUuid];
		return {
			sectionUuid,
			label: field?.kind === "section" ? (field.label ?? null) : null,
			fieldUuids: [...orderedFieldUuids(doc, sectionUuid)],
		};
	});
}

function describeCount(n: number): string {
	return `${n} ${n === 1 ? "section" : "sections"}`;
}

function pageTitle(label: ProseTemplate | null, index: number): string {
	const text = label ? proseTemplateText(label).trim() : "";
	return text.length > 0 ? `"${text}"` : `section ${index + 1} (untitled)`;
}
