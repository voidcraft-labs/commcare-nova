/**
 * Save to Case blocks in sources CommCare HQ served, retained under
 * `proof/hq-reads/`.
 *
 * Contract: a block is read as an operation only in the shape Nova's
 * emitter writes today. The two `targeted-migration-*` reads hold HQ's read
 * of an app Nova exported before its step 5 migration. A block whose shape
 * Nova no longer writes is the one finding
 * `questions/savetocase-block-outside-nova-s-own-block-shape` at its place
 * and no operation, with no canonicalization that would make an old shape
 * read as today's (a block Nova still writes, in a form whose changes the
 * gate refuses together, is that refusal's finding instead); a block of a
 * shape Nova still writes raises nothing, and
 * a guard of a block that raises it raises nothing of its own. The
 * plausible failure: a block of a shape Nova no longer writes read into an
 * operation, which the first publish would write in another shape, moving
 * an export path.
 */
import { describe, expect, it } from "vitest";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import {
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "../../__tests__/readerInput";
import { readCasesOfBody } from "./caseReading";
import { readHqApp } from "./heldReading";

const OUTSIDE = "questions/savetocase-block-outside-nova-s-own-block-shape";

interface BlockPlace {
	readonly menu: number;
	readonly form: number;
	readonly path: string;
}

/** Every block the form stage finds in a retained source, and the whole reading's findings of the
 *  new entry, each by its place. */
async function blocksAndFindings(read: string) {
	const body = retainedSourceBody(`${read}/app-source`);
	const firstPass = await readCasesOfBody(body);
	const blocks: BlockPlace[] = firstPass.forms.flatMap((form) =>
		(form.xform?.saveToCaseBlocks ?? []).map((block) => ({
			menu: form.place.kind === "form" ? form.place.menu : -1,
			form: form.place.kind === "form" ? form.place.form : -1,
			path: block.path.join("/"),
		})),
	);
	// The whole reading, the re-emission test of each block included.
	const outcome = readHqApp({
		...readerInput(await sourceFromBody(body)),
		recordDialect: recordDialectRoundTrip,
	});
	const findings = outcome.kind === "account" ? outcome.findings : [];
	const outside: BlockPlace[] = findings
		.filter((finding) => finding.code === OUTSIDE)
		.map((finding) => {
			const place = finding.place as {
				menu: number;
				form: number;
				path: string;
			};
			return { menu: place.menu, form: place.form, path: place.path };
		});
	return { blocks, outside, outcome };
}

describe("Save to Case blocks of an earlier shape, as CommCare HQ served them", () => {
	it("raises the new entry once at each block of targeted-migration-extension-children, every one of an earlier shape", async () => {
		const { blocks, outside, outcome } = await blocksAndFindings(
			"targeted-migration-extension-children",
		);
		expect(blocks.length).toBeGreaterThan(0);
		expect(outcome.kind).toBe("account");
		expect(outside).toEqual(expect.arrayContaining(blocks));
		expect(outside).toHaveLength(blocks.length);
		// The whole account: beside each block, the form's one inactive child case
		// (a `subcases[]` entry whose condition is `never`, which Nova wrote then
		// beside the block that carries the extension) is one finding, whatever
		// else the entry holds (its `relationship: extension`, the check on its
		// name's question), since removing it on HQ's Case Management page
		// removes all of it; no reader defect and no `unrecognized` finding.
		expect(outcome.defects).toEqual([]);
		const NEVER = "forms-and-case-writes/subcases-condition-never";
		expect(
			(outcome.kind === "account" ? outcome.findings : []).map((finding) => [
				finding.code,
				finding.place.kind,
				(finding.place as { path?: string }).path ?? null,
			]),
		).toEqual(
			blocks.flatMap((block) => [
				[NEVER, "form", null],
				[OUTSIDE, "question", block.path],
			]),
		);
	});

	it("raises the new entry at no block of targeted-migration-case-writes, whose Discharge form closes its own case beside its own change", async () => {
		const { blocks, outside, outcome } = await blocksAndFindings(
			"targeted-migration-case-writes",
		);
		// The follow-up's update, the conditional update, the create in a repeat (its answers and
		// the earlier create's id read through `current()`), the own close in a block of its own
		// and the several-case form's shared update of every selected case are written today as
		// they were then, and each guard is its operation's. The keyed create is read too: its id
		// is compared under the prefix the source's calculate holds, which names the app Nova
		// exported then.
		const keyed = "nova_operations/nova_keyed_add_referral/add_referral";
		const shared =
			"nova_selected_cases/item/nova_operations/nova_condition_update_selected_cases/nova_update_selected_cases";
		expect(blocks).toContainEqual({ menu: 1, form: 0, path: keyed });
		expect(blocks).toContainEqual({ menu: 2, form: 0, path: shared });
		const findings = outcome.kind === "account" ? outcome.findings : [];
		for (const path of [keyed, shared])
			expect(
				findings.filter(
					(finding) => (finding.place as { path?: string }).path === path,
				),
			).toEqual([]);
		// The Discharge form closes its own case in a block of its operation's name that also
		// writes the case's type: a close operation's block, as Nova writes one today, and not its
		// own close, whose close-only block writes no `update`. A close of the form's own case
		// beside its own change is a document the gate refuses (`CASE_OPERATION_CLOSES_OWN_CASE`),
		// so the reading is the one finding of that shape at the form, and no block is outside
		// Nova's shape.
		expect(outside).toEqual([]);
		expect(
			findings
				.filter(
					(finding) =>
						finding.code ===
						"questions/a-savetocase-change-of-the-form-s-own-case-beside-the-form-s-own-change-of-it",
				)
				.map((finding) => finding.place),
		).toEqual([expect.objectContaining({ kind: "form", menu: 1, form: 1 })]);
	});
});
