import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { formOfField } from "@/lib/domain/fieldForm";
import { entrySelectionSettings } from "@/lib/domain/formEntryCases";
import { entityTargetKey } from "@/lib/domain/referenceIndex";
import { listWithAnd } from "./caseListRegistrationDependents";
import { descendantFieldUuids } from "./fieldWalk";
import {
	type FormLinkRemovalTarget,
	planFormLinkDependentsOnRemove,
} from "./formLinkDependents";
import { referencingCarrierUuids, referencingSlotsOf } from "./referenceIndex";

/** Every surviving entry opening one of these forms, in the order the author sees it. */
function sharedEntriesOf(doc: BlueprintDoc, parents: ReadonlySet<Uuid>) {
	return doc.moduleOrder.flatMap((menuUuid) =>
		(doc.formOrder[menuUuid] ?? []).flatMap((uuid) => {
			const entry = doc.forms[uuid];
			return entry?.shadowOf &&
				parents.has(entry.shadowOf.form) &&
				!parents.has(uuid)
				? [
						{
							uuid,
							name: entry.name,
							menuName: doc.modules[menuUuid].name,
							opens: doc.forms[entry.shadowOf.form]?.name ?? "a form",
						},
					]
				: [];
		}),
	);
}

function listed(
	entries: ReturnType<typeof sharedEntriesOf>,
	naming: "entry" | "entry-and-form" = "entry",
): string {
	return listWithAnd(
		entries.map(
			(entry) =>
				`“${entry.name}” in “${entry.menuName}”${naming === "entry-and-form" ? ` (opens “${entry.opens}”)` : ""}`,
		),
	);
}

/** Removing a form can break two different entry points: a link that takes the
 * worker there after submit and an entry that opens its questions directly. */
export function planFormDependentsOnRemove(
	doc: BlueprintDoc,
	target: FormLinkRemovalTarget,
) {
	const links = planFormLinkDependentsOnRemove(doc, target);
	const removed =
		target.kind === "form"
			? [target.formUuid]
			: (doc.formOrder[target.moduleUuid] ?? []);
	const entries = sharedEntriesOf(doc, new Set(removed));
	if (!entries.length) return links;
	const shared =
		target.kind === "form"
			? `The following entries open this form: ${listed(entries)}. You can choose another form for each entry or remove the entries first.`
			: `The following entries open forms in this menu: ${listed(entries, "entry-and-form")}. You can choose another form for each entry or remove the entries first.`;
	const repairs = entries.map((entry) => entry.uuid).join(", ");
	return {
		kind: "blocked" as const,
		userMessage: [shared, links.kind === "blocked" && links.userMessage]
			.filter(Boolean)
			.join(" "),
		message: [
			shared,
			`Use edit_form_entry with change-shared-form for the entries ${repairs}.`,
			links.kind === "blocked" && links.message,
		]
			.filter(Boolean)
			.join(" "),
	};
}

/** A question used solely for display can be removed from the shared form in
 * one edit. A question that a retained calculation or write reads requires
 * an explicit edit to that consumer first. List only the entries affected:
 * a reader in shared content affects all entries, an entry-owned reader one. */
export function sharedQuestionRemovalRefusal(
	doc: BlueprintDoc,
	field: Uuid,
): string | undefined {
	const parent = formOfField(doc, field);
	if (!parent) return;
	const entries = sharedEntriesOf(doc, new Set([parent]));
	if (!entries.length) return;
	const subtree = new Set([field, ...descendantFieldUuids(doc, field)]);
	const carriers = new Set(
		[...subtree].flatMap((uuid) =>
			referencingCarrierUuids(doc, entityTargetKey(uuid)),
		),
	);
	const contentDepends = [...carriers].some(
		(carrier) =>
			carrier === parent ||
			(!subtree.has(carrier as Uuid) &&
				formOfField(doc, carrier as Uuid) === parent),
	);
	const affected = contentDepends
		? entries
		: entries.filter((entry) => carriers.has(entry.uuid));
	if (!affected.length) return;
	return `“${doc.fields[field].id}” is used when workers open ${listed(affected)}. You can change what reads or saves this answer, then remove the question.`;
}

/**
 * What reads one of `formUuid`'s opening choices, by the name a person sees.
 * A shared entry's replacement of its parent's choice is an edge to that
 * choice with the entry as carrier, which keeps the parent's choice from
 * being removed under it; it is no reader, so the entry is listed only where
 * something else of it reads the choice: another choice that follows it, or
 * an expression.
 */
export function choiceReaderNames(
	doc: BlueprintDoc,
	formUuid: Uuid,
	choice: Uuid,
): string[] {
	const key = entityTargetKey(choice);
	const form = doc.forms[formUuid];
	const replacesOnly = (carrier: string): boolean => {
		if (carrier !== formUuid || !form?.shadowOf) return false;
		if (
			!form.shadowOf.selections.some(
				(row) => row.kind === "replace" && row.selection === choice,
			)
		)
			return false;
		const slots = referencingSlotsOf(doc, key).get(carrier) ?? [];
		if (slots.some((slot) => slot !== "form_selection_source")) return false;
		return !(entrySelectionSettings(form) ?? []).some(
			(row) =>
				(row.source.kind === "choose" &&
					row.source.under?.selection === choice) ||
				(row.source.kind === "index" && row.source.selection === choice),
		);
	};
	return referencingCarrierUuids(doc, key)
		.filter((carrier) => !replacesOnly(carrier))
		.map(
			(id) =>
				doc.fields[id as Uuid]?.id ??
				doc.forms[id as Uuid]?.name ??
				doc.modules[id as Uuid]?.name,
		)
		.filter((name): name is string => name !== undefined);
}
