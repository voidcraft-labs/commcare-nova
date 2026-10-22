/**
 * Step 2, `form-link-datum-names` (part 09 §5, part 05 §1.5): a form link's
 * `datums[].name`, stored as the datum id the target entry prints, becomes
 * the `FormLinkDatumName` that id supplies, `{ kind: "selected-case",
 * module }`. It resolves through the target entry's datum ids
 * (`lib/commcare/formLinkProjection.ts::formLinkTargetDatumIds`, read over
 * the structure with every link's datums left out, since a link's own
 * values do not decide what its target asks for), exactly as the SA's form
 * link boundary resolves a name. The link sends the same datum id, so no
 * line is written; a name no scalar selection of the target carries is the
 * blocker `form-link-datum-unresolved`.
 */

import {
	formLinkProjectionContext,
	formLinkTargetDatumIds,
} from "@/lib/commcare/formLinkProjection";
import { formLinkTargetSchema } from "@/lib/domain/forms";
import type { JsonRecord, RawDocument } from "../oldShape";
import type { BlockerPlace, ExpressionsStep } from "../types";
import { WorkingDocument } from "./working";

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.filter(
				(entry): entry is Record<string, unknown> =>
					entry !== null && typeof entry === "object" && !Array.isArray(entry),
			)
		: [];
}

export const formLinkDatumNamesStep: ExpressionsStep = {
	id: "form-link-datum-names",
	apply(doc) {
		const named = Object.entries(doc.raw.forms).flatMap(([formUuid, form]) =>
			records(form.formLinks).flatMap((link) =>
				records(link.datums)
					.filter((datum) => typeof datum.name === "string")
					.map((datum) => ({ formUuid, link, datum })),
			),
		);
		if (named.length === 0)
			return { changes: [], blockers: [], classes: [], places: [] };

		const withoutDatums = structuredClone(doc.raw) as RawDocument;
		for (const form of Object.values(withoutDatums.forms))
			for (const link of records((form as JsonRecord).formLinks))
				delete link.datums;
		const structure = new WorkingDocument(
			doc.appId,
			withoutDatums,
			doc.lookupContext,
		).structure();
		const projection = structure.ok
			? formLinkProjectionContext(structure.doc, { entryMetadataOnly: true })
			: undefined;

		let resolved = 0;
		const places: BlockerPlace[] = [];
		for (const { formUuid, link, datum } of named) {
			const target = formLinkTargetSchema.safeParse(link.target);
			const rows =
				structure.ok && projection !== undefined && target.success
					? formLinkTargetDatumIds(structure.doc, projection, target.data)
					: [];
			const matches = rows.filter((row) => row.id === datum.name && row.scalar);
			const ref =
				matches.length === 1
					? matches[0].refs.find(
							(candidate) => candidate.kind === "selected-case",
						)
					: undefined;
			if (ref === undefined) {
				places.push({
					code: "form-link-datum-unresolved",
					entity: { kind: "form", uuid: formUuid },
					slot: "form_link_datum_name",
					text: String(datum.name),
				});
				continue;
			}
			datum.name = { kind: "selected-case", module: ref.module };
			resolved += 1;
		}
		doc.structureChanged();
		return {
			changes: [],
			blockers:
				places.length === 0
					? []
					: [
							{
								code: "form-link-datum-unresolved",
								count: places.length,
								findingCodes: [],
							},
						],
			classes:
				resolved === 0
					? []
					: [
							{
								step: "form-link-datum-names",
								class: "datum-name",
								count: resolved,
							},
						],
			places,
		};
	},
};
