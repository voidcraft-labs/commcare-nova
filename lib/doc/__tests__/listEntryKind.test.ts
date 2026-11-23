/**
 * A menu whose list opens a single match automatically, or lists the
 * worker's own record, reaches CommCare HQ only as an advanced menu: only an
 * `AdvancedModule` writes `auto_select_case`, and HQ's menu settings page
 * marks `commcare-user` an error on an ordinary one, which Nova's own reader
 * refuses to bring back. The plausible failure is an edit that adds
 * something keeping the menu basic (several cases, forms reading the
 * search, a parent chain under two index names) and is admitted, so the
 * menu ships as an ordinary one with automatic selection silently off and a
 * worker-record type HQ will not keep. Each blocker is shown through the
 * real commit gate beside a twin without the list's reason, which admits
 * the same edit's menu (or refuses it for something else only).
 */
import { describe, expect, it } from "vitest";
import { emittedModuleKind } from "@/lib/commcare/moduleKind";
import type { Mutation } from "@/lib/doc/types";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { isBlank, prop } from "@/lib/domain/expression/builders";
import {
	DIRECTORY,
	HOUSEHOLDS,
	K,
	kindFixture,
	MEMBERS,
	memberUnderTwoNames,
	VISITS,
} from "./moduleKindMoveFixture";
import { refusalCodes, verdict } from "./placementMoveFixture";

const CODE = "MENU_LIST_ENTRY_NEEDS_ADVANCED";

/** The form's starting value that reads its case, which a several-case
 *  form cannot read as one case. */
const noPreload = (id: string): Mutation =>
	({
		kind: "updateField",
		uuid: K(id),
		targetKind: "int",
		patch: { default_value: null },
	}) as Mutation;

const rows: readonly {
	readonly blocker: string;
	readonly module: Uuid;
	readonly edit: Mutation[];
	readonly sentence: string;
}[] = [
	{
		blocker: "several-cases",
		module: HOUSEHOLDS,
		edit: [
			noPreload("size"),
			{
				kind: "setCaseListMeta",
				uuid: HOUSEHOLDS,
				patch: { selection: { kind: "multiple", maximum: 5 } },
			} as Mutation,
		],
		sentence:
			"It now lets workers choose several cases, which an advanced menu can't do.",
	},
	{
		blocker: "forms-read-search",
		module: VISITS,
		edit: [
			{
				kind: "updateModule",
				uuid: VISITS,
				patch: {},
				caseSearchConfigPatch: { formsReadSearch: true },
			} as Mutation,
		],
		sentence: "Its forms now read the search, which an advanced menu can't do.",
	},
	{
		blocker: "chain-index",
		module: MEMBERS,
		edit: memberUnderTwoNames,
		sentence:
			"Its cases now link to their parent case under more than one name.",
	},
];

/** `moduleUuid` opens a single match automatically, in an app that runs on
 *  Android, since Web Apps refuses automatic selection beside a details
 *  screen (`auto-select-confirm`). */
function automatic(doc: BlueprintDoc, moduleUuid: Uuid): BlueprintDoc {
	doc.appSettings = { ...doc.appSettings, runsOnlyOn: "android" };
	doc.modules[moduleUuid] = {
		...doc.modules[moduleUuid],
		autoSelectSingle: true,
	};
	return doc;
}

describe("a menu that opens a single match automatically", () => {
	for (const row of rows)
		it(`refuses ${row.blocker}, which would keep the menu ordinary`, () => {
			const doc = automatic(kindFixture(), row.module);
			expect(refusalCodes(doc, [])).toEqual([]);
			expect(emittedModuleKind(doc, row.module)).toBe("advanced");
			const result = verdict(doc, row.edit);
			if (result.ok) throw new Error("The gate admitted the blocker.");
			const finding = result.findings.find((one) => one.code === CODE);
			if (finding === undefined)
				throw new Error(
					`No ${CODE}: ${result.findings.map((one) => one.code).join(", ")}`,
				);
			const name = doc.modules[row.module].name;
			const sentence = `The menu “${name}” opens a single match automatically, which only an advanced menu in CommCare HQ can do. ${row.sentence} You can turn off opening a single match automatically, or change that setting so the menu can be advanced.`;
			expect(finding.message).toBe(sentence);
			expect(userFacingError(finding)).toBe(sentence);
			expect(finding.details?.blocker).toBe(row.blocker);
			// The twin: the same edit on a menu without automatic selection
			// meets no such finding.
			expect(refusalCodes(kindFixture(), row.edit)).not.toContain(CODE);
		});

	// A filtered case list menu item keeps the menu basic (its advanced item
	// would list every open case), so automatic selection is refused there
	// rather than silently broadening the item.
	it("refuses automatic selection on a menu whose case list menu item is filtered", () => {
		const filtered = (doc: BlueprintDoc): BlueprintDoc => {
			const config = doc.modules[DIRECTORY].caseListConfig;
			if (config === undefined) throw new Error("Directory has a list.");
			doc.modules[DIRECTORY] = {
				...doc.modules[DIRECTORY],
				caseListConfig: {
					...config,
					filter: isBlank(prop("household", "size")),
				},
			};
			return doc;
		};
		const edit: Mutation[] = [
			{
				kind: "updateModule",
				uuid: DIRECTORY,
				patch: { autoSelectSingle: true },
			} as Mutation,
		];
		expect(refusalCodes(filtered(kindFixture()), edit)).toEqual([CODE]);
		expect(refusalCodes(kindFixture(), edit)).toEqual([]);
		const admitted = verdict(kindFixture(), edit);
		if (!admitted.ok) throw new Error("Unfiltered automatic selection.");
		expect(emittedModuleKind(admitted.nextDoc, DIRECTORY)).toBe("advanced");
	});
});

describe("a menu that lists the worker's own record", () => {
	it("refuses a filter on its case list menu item, which would keep it ordinary", () => {
		const doc = kindFixture();
		doc.modules[DIRECTORY] = {
			...doc.modules[DIRECTORY],
			caseType: "commcare-user",
		};
		expect(refusalCodes(doc, [])).toEqual([]);
		expect(emittedModuleKind(doc, DIRECTORY)).toBe("advanced");
		const result = verdict(doc, [
			{
				kind: "setCaseListMeta",
				uuid: DIRECTORY,
				patch: { filter: isBlank(prop("commcare-user", "case_name")) },
			} as Mutation,
		]);
		if (result.ok) throw new Error("The gate admitted the filter.");
		const finding = result.findings.find((one) => one.code === CODE);
		expect(finding?.message).toBe(
			"The menu “Directory” lists the worker’s own record, which only an advanced menu in CommCare HQ can do. Its case list in the menu now has a filter or a parent case, which an advanced menu would leave out. You can choose another record type for it, or change that setting so the menu can be advanced.",
		);
	});
});
