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
 * read as today's; a block of a shape Nova still writes raises nothing, and
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
import { readHqApp } from "../../index";
import { readCasesOfBody } from "./caseReading";

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
	});

	it("raises the new entry at no block of targeted-migration-case-writes, every one of a shape Nova still writes", async () => {
		const { blocks, outside, outcome } = await blocksAndFindings(
			"targeted-migration-case-writes",
		);
		// The follow-up's update, the conditional update, the create in a repeat (its answers and
		// the earlier create's id read through `current()`), the closes and the several-case
		// form's shared update of every selected case are written today as they were then, and
		// each guard is its operation's. The keyed create is read too: its id is compared under
		// the prefix the source's calculate holds, which names the app Nova exported then.
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
		expect(outside).toEqual([]);
	});
});
