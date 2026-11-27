/**
 * The name and the owner of a case above the form's own, saved through the
 * links that reach it (`parent/name`, `host/owner_id`).
 *
 * Contract: CommCare HQ's build writes such a key into the block of the case
 * the index reaches, `name` as its `case_name` and `owner_id` as its owner
 * (`xform.py::XFormCaseBlock.add_case_updates`), and Core and HQ's server
 * set that case's name and owner from it (`CaseXmlParser.updateCase`,
 * `update_strategy.py::_apply_update_action`). Nova holds it as a write of
 * `case_name` or `owner_id` with `via`, on the own case of a form that loads
 * its case, as every other write through `via` is: the commit gate admits
 * it, the chat and MCP tools take it, and the export writes the same key HQ
 * stores. Without `via` the two stay the operation's own facets.
 *
 * The plausible failures: the gate refusing the write as a reserved property
 * or an undeclared one; the tools refusing it before the gate sees it; the
 * export writing `case_name` where HQ's key is `name`; the gate admitting
 * `case_name` with no `via`, which would write the own case's name past its
 * facet.
 */
import { describe, expect, it } from "vitest";
import { ownOperationInputSchema } from "@/lib/agent/tools/case-operations/shared";
import {
	own,
	placementFixture,
	read,
} from "@/lib/commcare/__tests__/placementFixture";
import { expandDoc } from "@/lib/commcare/expander";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { CaseOperation, CaseOperationWrite } from "@/lib/domain";
import { runValidation } from "../../runner";

const toHousehold = [
	{ identifier: "host", throughCaseType: "household" },
] as const;

function facet(property: "case_name" | "owner_id"): CaseOperationWrite {
	return { property, value: read("name"), via: [...toHousehold] };
}

function codes(operations: () => CaseOperation[], formType = "followup") {
	const { doc } = placementFixture(formType as "followup", { operations });
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
		(error) => error.code,
	);
}

describe("the name and owner of a case above", () => {
	it("are admitted as writes through the link on a follow-up's own case", () => {
		expect(
			codes(() => [own({ writes: [facet("case_name"), facet("owner_id")] })]),
		).toEqual([]);
	});

	it("stay the operation's own facets without a link", () => {
		for (const property of ["case_name", "owner_id"] as const) {
			const found = codes(() => [
				own({ writes: [{ property, value: read("name") }] }),
			]);
			expect(found, property).toContain("CASE_OPERATION_RESERVED_PROPERTY");
		}
	});

	it("are refused on a case the form creates, as every write through a link is", () => {
		const found = codes(
			() => [own({ name: read("name"), writes: [facet("case_name")] })],
			"registration",
		);
		expect(found).toContain("CASE_WRITE_VIA_INVALID");
		expect(found).not.toContain("CASE_OPERATION_RESERVED_PROPERTY");
	});

	it("are taken by the own case's tool input with a link and refused without one", () => {
		const withLink = ownOperationInputSchema.safeParse({
			action: "own",
			writes: [
				{
					property: "case_name",
					value: read("name"),
					via: [{ identifier: "host", throughCaseType: "household" }],
				},
				{
					property: "owner_id",
					value: read("name"),
					via: [{ identifier: "host", throughCaseType: "household" }],
				},
			],
		});
		expect(withLink.success ? [] : withLink.error.issues).toEqual([]);
		for (const property of ["case_name", "owner_id"]) {
			const without = ownOperationInputSchema.safeParse({
				action: "own",
				writes: [{ property, value: read("name") }],
			});
			expect(without.success, property).toBe(false);
		}
	});

	it("are exported as HQ's own keys of the case above", () => {
		const { doc } = placementFixture("followup", {
			operations: () => [
				own({ writes: [facet("case_name"), facet("owner_id")] }),
			],
		});
		const app = expandDoc(doc) as unknown as {
			modules: {
				forms: {
					name: Record<string, string>;
					actions: {
						update_case: { update: Record<string, { question_path: string }> };
					};
				}[];
			}[];
		};
		const form = app.modules[0]?.forms.find(
			(candidate) => candidate.name.en === "Under test",
		);
		const update = form?.actions.update_case.update ?? {};
		expect(Object.keys(update).sort()).toEqual(["host/name", "host/owner_id"]);
		// The name reads the question's trimmed sibling, as every name does.
		expect(update["host/name"]?.question_path).toMatch(/nova_trimmed_/);
		expect(update["host/owner_id"]?.question_path).toBe("/data/name");
	});
});
