/**
 * The fixed point of a reading: re-reading Nova's own emission of the
 * document a reading gave gives that document exactly.
 *
 * Pure. No canonical form is applied: the document a reading gave is already
 * in the reader's image, so a canonicalization here would forgive exactly the
 * reader that returns one member of a pair for CommCare HQ's bytes and the
 * other for Nova's. Each difference is named by a content-free signature and
 * placed at the entity it lies in, through the naming acceptance hands over,
 * which reads the source's own names for each place.
 */

import type { ReadOutcome } from "@/lib/commcare/reader";
import type { ValidationLocation } from "@/lib/commcare/validator/errors";
import { documentDifferences } from "@/lib/doc/documentDifferences";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

/** At most this many differences of the documents are kept, the first in the walk's order. */
export const FIXED_POINT_DIFFERENCES_KEPT = 20;

/** One way the re-read did not give the document, for a developer and a test. */
export interface FixedPointDifference {
	readonly check: "fixed-point";
	/** Content-free, from `naming.signature`. */
	readonly signature: string;
	readonly place: HqPlace;
	/** What differs, in the app's own words. This string never leaves the process. */
	readonly detail: string;
}

/** How a difference is named and placed, as acceptance names every difference it finds. */
export interface FixedPointNaming {
	/** The place of the entity a location names, with the source's own names. */
	readonly placeOf: (location: ValidationLocation) => HqPlace;
	/** The signature of the segments that follow the check. */
	readonly signature: (segments: readonly string[]) => string;
	/** A document path as content-free segments. */
	readonly pathKinds: (path: readonly string[]) => readonly string[];
}

/**
 * Where the re-read of Nova's emission of `expected` does not give `expected`,
 * in order, the first step that differs ending the check: an account for
 * Nova's own emission, at each finding's place; a reader defect, or a
 * hand-off the reading did not make (the re-read may make fewer: a reference
 * with no file that was left out as inert is in no document, so Nova's
 * emission does not write it); then the two documents, compared as
 * canonical JSON and, where they differ, path by path, the first twenty
 * paths kept. A difference of the split document's re-read carries `split`
 * after the check.
 */
export function fixedPointDifferences(
	/** The document the re-read must give. */
	expected: BlueprintDoc,
	/** The re-read's answer. */
	again: ReadOutcome,
	reading: {
		/** The reading: its hand-offs are the other side of the second step. */
		readonly outcome: Extract<ReadOutcome, { readonly kind: "read" }>;
	},
	naming: FixedPointNaming,
	options: { readonly split?: boolean } = {},
): readonly FixedPointDifference[] {
	const lead = options.split === true ? ["split"] : [];
	const difference = (
		segments: readonly string[],
		place: HqPlace,
		detail: string,
	): FixedPointDifference => ({
		check: "fixed-point",
		signature: naming.signature([...lead, ...segments]),
		place,
		detail,
	});
	const app = naming.placeOf({});

	if (again.kind === "account")
		return again.findings.map((finding) =>
			difference(
				["account", finding.standing],
				finding.place,
				`${finding.code}${finding.detail.name === undefined ? "" : `: ${finding.detail.name}`}`,
			),
		);

	if (again.defects.length > 0)
		return again.defects.map((defect) =>
			difference(
				["defect"],
				defect.place,
				`${defect.name}: ${JSON.stringify(defect.why)}`,
			),
		);
	const made = new Set(
		reading.outcome.claims.handOffs.map(
			(one) => `${one.to}\u0000${one.subject}`,
		),
	);
	const unmade = again.claims.handOffs.filter(
		(one) => !made.has(`${one.to}\u0000${one.subject}`),
	);
	if (unmade.length > 0)
		return unmade.map((one) =>
			difference(
				["hand-offs"],
				app,
				`a ${one.to} hand-off of ${one.subject} the reading did not make`,
			),
		);

	const read = again.draft.doc;
	if (
		canonicalJsonDigest(toPersistableDoc(read)) ===
		canonicalJsonDigest(toPersistableDoc(expected))
	)
		return [];
	return documentDifferences(expected, read)
		.slice(0, FIXED_POINT_DIFFERENCES_KEPT)
		.map((one) =>
			difference(
				naming.pathKinds(one.path),
				naming.placeOf(
					locationOfPath(one.path, expected) ??
						locationOfPath(one.path, read) ??
						{},
				),
				`${one.kind} /${one.path.join("/")}`,
			),
		);
}

/** The form that holds `uuid`, a form or a field, in `doc`. */
function formHolding(doc: BlueprintDoc, uuid: Uuid): Uuid | undefined {
	if (Object.hasOwn(doc.forms, uuid)) return uuid;
	for (const [parent, children] of Object.entries(doc.fieldOrder))
		if (children.includes(uuid)) return formHolding(doc, parent as Uuid);
	return undefined;
}

/** The menu that holds the form `formUuid` in `doc`. */
function menuHolding(doc: BlueprintDoc, formUuid: Uuid): Uuid | undefined {
	for (const [menu, forms] of Object.entries(doc.formOrder))
		if (forms.includes(formUuid)) return menu as Uuid;
	return undefined;
}

/**
 * The entity a document path lies in, as a location acceptance places: a
 * question, a form or a menu that `doc` holds, with the entities around it;
 * undefined where `doc` holds no such entity, and the app where the path
 * lies in no entity.
 */
function locationOfPath(
	path: readonly string[],
	doc: BlueprintDoc,
): ValidationLocation | undefined {
	const [top, key] = path;
	const uuid = key as Uuid | undefined;
	if (uuid === undefined) return {};
	const inForm = (formUuid: Uuid): ValidationLocation => {
		const moduleUuid = menuHolding(doc, formUuid);
		return { formUuid, ...(moduleUuid !== undefined && { moduleUuid }) };
	};
	switch (top) {
		case "modules":
		case "formOrder":
			return Object.hasOwn(doc.modules, uuid)
				? { moduleUuid: uuid }
				: undefined;
		case "forms":
			return Object.hasOwn(doc.forms, uuid) ? inForm(uuid) : undefined;
		case "fields":
		case "fieldOrder": {
			if (top === "fieldOrder" && Object.hasOwn(doc.forms, uuid))
				return inForm(uuid);
			if (!Object.hasOwn(doc.fields, uuid)) return undefined;
			const formUuid = formHolding(doc, uuid);
			return formUuid === undefined
				? undefined
				: { ...inForm(formUuid), fieldUuid: uuid };
		}
		default:
			return {};
	}
}
