/**
 * A form's read of an ancestor case walks one index by its name
 * (`advancedModule.ts::ancestorWalk`), and the commit gate refuses a read
 * no one name walks for every case the app links.
 *
 * Contract: in a menu of members of households, a read of the household's
 * property walks the index every member the app links to a household
 * carries, whatever its relationship: the one name the app writes, the name
 * every creating operation writes where it writes several, an extension
 * link's own name (CommCare HQ's convention for a host is `host`,
 * `casexml/apps/case/const.py::DEFAULT_CASE_INDEX_IDENTIFIERS`). Where no one
 * name is on every member (one create links `home`, another `guardian`; a
 * create that links no household beside an update that links another name;
 * an update that removes the one name every create writes), or where the one
 * name the child links use, the one a parent selection lists a member under,
 * is not on every member, every read of the household is
 * `FORM_CASE_READ_ACROSS_SEVERAL_LINKS` at its slot, in the checker's words
 * and the builder's. Where the child links use one name that is on every
 * member, the read walks it, so an advanced form reads the household its
 * chained load was chosen through (`case_index.reference_id`).
 *
 * The plausible failures: the read walking `index/parent` where the app links
 * the pair under several names none of which is `parent`, or under an
 * extension link named otherwise, which reads every household value blank on
 * a device; or the gate refusing a read every member's index serves.
 */
import { findOne } from "domutils";
import { describe, expect, it } from "vitest";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { ancestorWalk } from "@/lib/domain/advancedModule";
import { formField, term } from "@/lib/domain/expression/builders";
import { slotContext } from "@/lib/domain/expression/context";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import type { Expression } from "@/lib/domain/expression/types";
import {
	advancedFixture,
	HOUSEHOLD_VISIT,
	MEMBERS,
	OP,
	read,
	U,
	UNDER_TEST,
} from "../../__tests__/advancedPlacementFixture";
import { expandDoc } from "../../expander";
import { parseXml } from "../../xmlParse";
import { runValidation } from "../runner";

const householdRemark: Expression = {
	kind: "term",
	term: { kind: "form-case", caseType: "household", property: "remark" },
};

interface Link {
	readonly identifier: string;
	readonly relationship?: "child" | "extension";
	/** A link with no target, which removes the index it names. */
	readonly removes?: true;
}

interface Options {
	readonly extension?: boolean;
	readonly update?: number;
	/** Holds the members menu advanced, its load chained to the household's. */
	readonly advanced?: boolean;
}

/**
 * Households and their members. The household visit runs one operation per
 * entry of `linkings`, each linking the member it works on to the visited
 * household under that entry's names: a create, or, where `update`, an
 * update of the member chosen by id. The member's follow-up shows its note
 * only while the household has no remark. `extension` declares a member an
 * extension of its household and lists members flat.
 */
function members(
	linkings: readonly (readonly Link[])[],
	options: Options = {},
): BlueprintDoc {
	return advancedFixture({
		formType: "followup",
		menu: "members",
		heldKind: options.advanced === true,
		operations: () => [
			{
				uuid: OP("own"),
				id: "member",
				action: "own",
				writes: [{ property: "age", value: read("age") }],
			},
		],
		configure: (doc) => {
			const remark = doc.fieldOrder[HOUSEHOLD_VISIT]?.[0] as Uuid;
			doc.forms[HOUSEHOLD_VISIT] = {
				...doc.forms[HOUSEHOLD_VISIT],
				caseOperations: [
					{
						uuid: OP("household"),
						id: "household",
						action: "own",
						writes: [{ property: "remark", value: term(formField(remark)) }],
					},
					...linkings.map((links, index) => {
						const shared = {
							uuid: OP(`member${index}`),
							id: `member${index}`,
							caseType: "member",
							...(links.length > 0 && {
								links: links.map((link) => ({
									identifier: link.identifier,
									targetType: "household",
									target: link.removes === true ? null : { kind: "session" },
									relationship: link.relationship ?? "child",
								})),
							}),
						};
						return index === options.update
							? {
									...shared,
									action: "update",
									target: {
										kind: "expression",
										expr: term(formField(remark)),
									},
								}
							: {
									...shared,
									action: "create",
									target: { kind: "new" },
									name: term(formField(remark)),
								};
					}),
				],
			} as never;
			const note = U("note");
			doc.fields[note] = {
				...doc.fields[note],
				relevant: { kind: "is-blank", left: householdRemark },
			} as never;
			if (options.extension === true) {
				doc.caseTypes = (doc.caseTypes ?? []).map((type) =>
					type.name === "member"
						? { ...type, relationship: "extension" }
						: type,
				);
				const { parentCaseModuleUuid: _flat, ...module } = doc.modules[
					MEMBERS
				] as BlueprintDoc["modules"][Uuid] & { parentCaseModuleUuid?: Uuid };
				doc.modules[MEMBERS] = module as never;
			}
		},
	}).doc;
}

/** The members follow-up as the HQ import file holds it. */
function memberForm(doc: BlueprintDoc) {
	const app = expandDoc(doc);
	const form = app.modules[1]?.forms[0] as unknown as {
		readonly unique_id: string;
		readonly case_references_data?: { readonly load?: unknown };
	};
	const source = (app._attachments as Record<string, string>)[
		`${form.unique_id}.xml`
	];
	if (source === undefined) throw new Error("The form has its source.");
	const relevant = findOne(
		(element) =>
			element.name === "bind" && element.attribs.nodeset === "/data/note",
		parseXml(source).children,
	)?.attribs.relevant;
	return { load: form.case_references_data?.load, relevant };
}

/** The note's condition over the member chosen as `datum`, walking `index`. */
const printed = (index: string, datum = "case_id") =>
	"string-length(string(instance('casedb')/casedb/case[@case_id = " +
	`instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/${datum}]` +
	`/index/${index}]/remark)) = 0`;

const codes = (doc: BlueprintDoc) =>
	runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((finding) => finding.code);

describe("the index a read of the household walks", () => {
	it("walks the one name every member carries", () => {
		const cases: readonly [
			string,
			readonly (readonly Link[])[],
			string,
			Options,
		][] = [
			["one name", [[{ identifier: "home" }]], "home", {}],
			[
				"two names on every create",
				[[{ identifier: "home" }, { identifier: "guardian" }]],
				"home",
				{},
			],
			[
				"parent on every create, beside another name",
				[
					[{ identifier: "home" }, { identifier: "parent" }],
					[{ identifier: "parent" }],
				],
				"parent",
				{},
			],
			[
				"a name every create writes, an update adding another",
				[[{ identifier: "home" }], [{ identifier: "guardian" }]],
				"home",
				{ update: 1 },
			],
			[
				"an extension's own name",
				[[{ identifier: "host", relationship: "extension" }]],
				"host",
				{ extension: true },
			],
			[
				// The one name the child links use is the one an advanced
				// menu chooses a member under its household by, so the read
				// walks it rather than the extension's, first in the link.
				"the advanced chain's name, beside an extension every create writes",
				[
					[
						{ identifier: "host", relationship: "extension" },
						{ identifier: "home" },
					],
				],
				"home",
				{ advanced: true },
			],
			[
				"the name left where an update removes the other",
				[
					[{ identifier: "home" }, { identifier: "guardian" }],
					[{ identifier: "home", removes: true }],
				],
				"guardian",
				{ update: 1 },
			],
			[
				"one name, beside a create that links no household",
				[[], [{ identifier: "home" }]],
				"home",
				{},
			],
		];
		for (const [label, linkings, index, options] of cases) {
			const doc = members(linkings, options);
			expect(ancestorWalk(doc, "member", "household"), label).toMatchObject({
				kind: "one",
				identifier: index,
			});
			const { relevant, load } = memberForm(doc);
			expect(relevant, label).toBe(
				printed(
					index,
					options.advanced === true ? "case_id_load_member1" : "case_id",
				),
			);
			if (options.advanced === true) {
				// HQ's build lists the member by `[index/<reference_id>=…]`, the
				// same index the read walks.
				const form = expandDoc(doc).modules[1]?.forms[0] as unknown as
					| {
							readonly actions?: { readonly load_update_cases?: unknown[] };
					  }
					| undefined;
				const [, own] = (form?.actions?.load_update_cases ?? []) as {
					readonly case_index?: { readonly reference_id?: string };
				}[];
				expect(own?.case_index?.reference_id, label).toBe(index);
			}
			expect(load).toEqual({
				"/data/note": [`#case/${index}/remark`],
			});
			expect(codes(doc), label).not.toContain(
				"FORM_CASE_READ_ACROSS_SEVERAL_LINKS",
			);
		}
	});

	it("keeps an app whose members carry no other name exactly as it was", () => {
		const doc = members([[{ identifier: "parent" }]]);
		expect(codes(doc)).toEqual([]);
		expect(memberForm(doc).relevant).toBe(printed("parent"));
	});
});

describe("a read no one name walks for every member", () => {
	const doc = members([[{ identifier: "home" }], [{ identifier: "guardian" }]]);

	it("is several names, with no walk the gate admits", () => {
		expect(ancestorWalk(doc, "member", "household")).toEqual({
			kind: "several",
			identifiers: ["home", "guardian"],
			why: { kind: "no-name" },
		});
	});

	it("is several names where a create links no household and an update links a member under another name", () => {
		// Members registered alone and later assigned carry only `guardian`,
		// so `home`, the one name the linking create writes, is not on them.
		const assigned = members(
			[[], [{ identifier: "home" }], [{ identifier: "guardian" }]],
			{ update: 2 },
		);
		expect(ancestorWalk(assigned, "member", "household")).toEqual({
			kind: "several",
			identifiers: ["home", "guardian"],
			why: { kind: "no-name" },
		});
		expect(codes(assigned)).toContain("FORM_CASE_READ_ACROSS_SEVERAL_LINKS");
	});

	it("is several names where an update removes the one name every create writes", () => {
		const removed = members(
			[
				[{ identifier: "home" }],
				[{ identifier: "home", removes: true }, { identifier: "guardian" }],
			],
			{ update: 1 },
		);
		expect(ancestorWalk(removed, "member", "household")).toMatchObject({
			kind: "several",
			why: { kind: "no-name" },
		});
		expect(codes(removed)).toContain("FORM_CASE_READ_ACROSS_SEVERAL_LINKS");
	});

	it("is refused at the read, in the checker's words and the builder's", () => {
		const ctx = slotContext(
			doc,
			{ entity: "field", uuid: U("note"), slot: "relevant" },
			new Map(),
		);
		if (ctx === undefined) throw new Error("The note's condition has a slot.");
		expect(
			checkExpression(householdRemark, ctx).errors.map((error) => [
				error.code,
				error.reason,
			]),
		).toContainEqual(["relation-ambiguous", "ancestor-link-names"]);
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "FORM_CASE_READ_ACROSS_SEVERAL_LINKS",
		);
		expect(findings).toHaveLength(1);
		const [finding] = findings;
		expect(finding?.location.formUuid).toBe(UNDER_TEST);
		expect(finding?.location.fieldUuid).toBe(U("note"));
		expect(finding?.details).toMatchObject({
			hashtag: "#household/remark",
			childCaseType: "member",
			parentCaseType: "household",
			identifiers: "home guardian",
		});
		expect(finding?.message).toBe(
			`"note"'s display condition reads the household case's "remark", but this app links a member case to its household case under several names (home and guardian), and no one name is on every member case it links. A form reads through one name, so this read would be blank for the cases linked under another. You can link every member case to its household case under one name, or remove this read.`,
		);
		expect(finding === undefined ? "" : userFacingError(finding)).toBe(
			`A formula on "note" in "Under test" reads "#household/remark", but this app links a member case to its household case under several names (home and guardian), and no one name is on every member case it links. A form reads through one name, so this read would be blank for the cases linked under another. You can link every member case to its household case under one name, or remove this read.`,
		);
	});

	it("refuses nothing while no form reads across the hop", () => {
		const unread = members([
			[{ identifier: "home" }],
			[{ identifier: "guardian" }],
		]);
		const note = U("note");
		const { relevant: _read, ...field } = unread.fields[note] as never as {
			relevant?: unknown;
		};
		unread.fields[note] = field as never;
		expect(codes(unread)).not.toContain("FORM_CASE_READ_ACROSS_SEVERAL_LINKS");
	});
});

describe("a read where the name members are chosen by is not on every member", () => {
	// Every create extends the household as `host`; an update links a member
	// as `home`, the one child link, the name an advanced menu lists a member
	// under its household by (`entries.py::get_parent_filter_by_ref_id`). A
	// read through `home` is blank for a member never updated, and one
	// through `host` reads a household other than the one it was chosen
	// under.
	const doc = members(
		[
			[{ identifier: "host", relationship: "extension" }],
			[{ identifier: "home" }],
		],
		{ update: 1, advanced: true },
	);

	it("is several names, the chain's missing from some members", () => {
		expect(ancestorWalk(doc, "member", "household")).toEqual({
			kind: "several",
			identifiers: ["host", "home"],
			why: { kind: "child-name", identifier: "home" },
		});
	});

	it("is refused at the read, naming the link members are listed by", () => {
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "FORM_CASE_READ_ACROSS_SEVERAL_LINKS",
		);
		expect(findings).toHaveLength(1);
		const [finding] = findings;
		expect(finding?.details).toMatchObject({
			identifiers: "host home",
			childIdentifier: "home",
		});
		expect(finding?.message).toBe(
			`"note"'s display condition reads the household case's "remark", but this app links a member case to its household case as home, the one name a member case is listed under its household case by, and not every member case it links carries home (it links them under host and home). A form reads through one name, so this read would be blank for the member cases without home, or read a household case other than the one they are listed under. You can link every member case to its household case as home, or remove this read.`,
		);
		expect(finding === undefined ? "" : userFacingError(finding)).toBe(
			`A formula on "note" in "Under test" reads "#household/remark", but this app links a member case to its household case as home, the one name a member case is listed under its household case by, and not every member case it links carries home (it links them under host and home). A form reads through one name, so this read would be blank for the member cases without home, or read a household case other than the one they are listed under. You can link every member case to its household case as home, or remove this read.`,
		);
	});
});
