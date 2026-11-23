import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { formOfField } from "@/lib/domain/fieldForm";
import { entityTargetKey } from "@/lib/domain/referenceIndex";
import { listWithAnd } from "./caseListRegistrationDependents";
import { descendantFieldUuids } from "./fieldWalk";
import {
	type FormLinkRemovalTarget,
	planFormLinkDependentsOnRemove,
} from "./formLinkDependents";
import { referencingCarrierUuids } from "./referenceIndex";

/** Every surviving entry opening one of these forms, in the order the author sees it. */
function sharedEntriesOf(doc: BlueprintDoc, parents: ReadonlySet<Uuid>) {
	return doc.moduleOrder.flatMap((menuUuid) =>
		(doc.formOrder[menuUuid] ?? []).flatMap((uuid) => {
			const entry = doc.forms[uuid];
			return entry?.shadowOf &&
				parents.has(entry.shadowOf.form) &&
				!parents.has(uuid)
				? [{ uuid, name: entry.name, menuName: doc.modules[menuUuid].name }]
				: [];
		}),
	);
}

function listed(entries: ReturnType<typeof sharedEntriesOf>): string {
	return listWithAnd(
		entries.map((entry) => `“${entry.name}” in “${entry.menuName}”`),
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
	const shared = `The following entries open this form: ${listed(entries)}. You can choose another form for each entry or remove the entries first.`;
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
