/**
 * An advanced open action whose index under `parent` reaches another case
 * type, or reaches it as an extension, than the parent selection a menu of
 * the open action's type chooses through, read from CommCare HQ's own bytes:
 * the retained `hq-advanced` base (Member visits, an advanced menu loading
 * the household chosen in Households and then the member under it), with the
 * one change `proof/matrix/variants.json`'s row
 * `hq-advanced/member-opened-under-a-member-against-the-menu-s-household`
 * makes, an open action of a member indexed under `parent` to the chosen
 * member.
 *
 * Contract: the reading comes in and claims the shape under its own HELD
 * entry; the open operation links to the chosen member and the form selects
 * that member under the chosen household; the
 * read document passes the commit gate; and Nova's emission of it writes the
 * open action's index and the load chain's as HQ stores them, so a publish
 * changes neither. A base without the index claims no such entry.
 *
 * Plausible failure: a reader that refuses the shape again (the selection
 * once followed the catalog, which then had no parent for the type), one that
 * reads it but loses or re-targets the index, an emission that writes the
 * load chain's index from the catalog, or a claim made of an ordinary index.
 */
import { describe, expect, it } from "vitest";
import { laneInputOf, retainedBase } from "@/__tests__/helpers/retainedHqApps";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { readForLane } from "@/proof/reader/laneReading";
import { claimedEntries } from "../../__tests__/retainedBaseControl";

const ENTRY =
	"forms-and-case-writes/an-advanced-open-action-s-parent-index-against-a-menu-s-parent-selection";

type Json = Record<string, unknown>;

/** HQ's stored open action of a member, indexed under `parent` to `tag`. */
function openMember(tag: string, relationship: "child" | "extension"): Json {
	const condition = (type: string) => ({
		type,
		question: null,
		answer: null,
		operator: "=",
		doc_type: "FormActionCondition",
	});
	return {
		case_type: "member",
		case_tag: "open_member_0",
		name_update: {
			question_path: "/data/notes",
			update_mode: "always",
			doc_type: "ConditionalCaseUpdate",
		},
		case_properties: {},
		repeat_context: "",
		case_indices: [
			{
				tag,
				reference_id: "parent",
				relationship,
				relationship_question: "",
				doc_type: "CaseIndex",
			},
		],
		open_condition: condition("always"),
		close_condition: condition("never"),
		doc_type: "AdvancedOpenCaseAction",
	};
}

/** The base's reading, with Member visits' form holding `opens` where given. */
async function read(opens?: readonly Json[]) {
	const input = laneInputOf(retainedBase("hq-advanced"));
	const source = structuredClone(input.source) as { body: string };
	const app = JSON.parse(source.body) as {
		modules: { forms: { actions: Json }[] }[];
	};
	const actions = app.modules[1]?.forms[0]?.actions as Json;
	if (opens !== undefined) actions.open_cases = opens;
	source.body = JSON.stringify(app);
	const reading = await readForLane({
		...input,
		source: source as typeof input.source,
	});
	return { reading, stored: actions };
}

function moduleNamed(doc: BlueprintDoc, name: string) {
	const found = Object.values(doc.modules).find((one) => one.name === name);
	if (found === undefined) throw new Error(`no menu ${name}`);
	return found;
}

describe("an advanced open action's parent index against a menu's parent selection", () => {
	it("reads, holds the index and the selection, passes the gate and writes both back as HQ stores them", async () => {
		const { reading, stored } = await read([
			openMember("load_member1", "child"),
		]);
		if (reading.kind !== "read")
			throw new Error(`the reading did not come in: ${reading.kind}`);
		expect(claimedEntries(reading.claims)).toContain(ENTRY);
		const doc = reading.doc;
		const visits = moduleNamed(doc, "Member visits");
		const [formUuid] = doc.formOrder[visits.uuid] ?? [];
		const readForm = doc.forms[formUuid];
		const [household, member] = readForm?.caseSelections ?? [];
		if (!household || !member)
			throw new Error("Expected the two form selections");
		expect(household).toMatchObject({
			caseType: "household",
			tag: "load_household0",
			source: { kind: "choose", module: moduleNamed(doc, "Households").uuid },
		});
		expect(member).toMatchObject({
			caseType: "member",
			tag: "load_member1",
			source: {
				kind: "choose",
				module: visits.uuid,
				under: { selection: household.uuid, identifier: "parent" },
			},
		});
		expect(readForm.caseOperations?.[0]).toMatchObject({
			action: "own",
			placement: { kind: "advanced", tag: "open_member_0" },
			links: [
				{
					identifier: "parent",
					targetType: "member",
					relationship: "child",
					target: {
						kind: "expression",
						expr: {
							kind: "term",
							term: {
								kind: "session-datum",
								datum: { kind: "form-selection", selection: member.uuid },
							},
						},
					},
				},
			],
		});
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);

		const form = expandDoc(doc).modules[1]?.forms[0];
		if (form?.doc_type !== "AdvancedForm")
			throw new Error("Expected an advanced form");
		const emitted = form.actions as unknown as Json;
		const indexOf = (index: Json) => ({
			tag: index.tag,
			reference_id: index.reference_id,
			relationship: index.relationship,
		});
		const opens = (actions: Json) =>
			(actions.open_cases as Json[]).map((open) =>
				(open.case_indices as Json[]).map(indexOf),
			);
		const chain = (actions: Json) =>
			(actions.load_update_cases as Json[]).map((load) => [
				load.case_tag,
				(load.case_index as Json).reference_id,
				(load.case_index as Json).tag || null,
			]);
		expect(opens(emitted)).toEqual(opens(stored));
		expect(chain(emitted)).toEqual(chain(stored));
	});

	it("claims an index to the selection's own type made as an extension", async () => {
		const { reading } = await read([
			openMember("load_household0", "extension"),
		]);
		if (reading.kind !== "read")
			throw new Error(`the reading did not come in: ${reading.kind}`);
		expect(claimedEntries(reading.claims)).toContain(ENTRY);
	});

	it("claims nothing of an index to the type the selection chooses through, as a child", async () => {
		const { reading } = await read([openMember("load_household0", "child")]);
		if (reading.kind !== "read")
			throw new Error(`the reading did not come in: ${reading.kind}`);
		expect(claimedEntries(reading.claims)).not.toContain(ENTRY);
		const { reading: base } = await read();
		if (base.kind !== "read")
			throw new Error(`the base did not come in: ${base.kind}`);
		expect(claimedEntries(base.claims)).not.toContain(ENTRY);
	});
});
