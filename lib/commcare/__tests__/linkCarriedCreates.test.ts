/**
 * Which creates a form's after-submit links carry into their targets. A
 * carried create needs a session datum, which decides whether its menu is
 * emitted advanced, so a link Nova reads as carrying a different case than
 * HQ's `_find_best_match` would carry (`suite_xml/post_process/workflow.py`)
 * turns a menu advanced for nothing, or leaves a link opening its target on
 * a case id no entry gives.
 */
import { describe, expect, it } from "vitest";
import {
	carriedCreateLinks,
	linkCarriedCreates,
} from "@/lib/commcare/formLinkProjection";
import type {
	BlueprintDoc,
	CaseOperation,
	CaseOperationLink,
	FormLink,
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import {
	type AdvancedFixtureOptions,
	advancedFixture,
	HOUSEHOLD_VISIT,
	HOUSEHOLDS,
	OP,
	read,
	U,
	UNDER_TEST,
	VISIT_REVIEW,
	VISITS,
} from "./advancedPlacementFixture";

const OWN = OP("own");
const LINK = OP("link");
const LINK_B = OP("link-b");

const toOwn = (
	relationship: CaseOperationLink["relationship"] = "child",
	target: CaseOperationLink["target"] = { kind: "op", opUuid: OWN },
): CaseOperationLink => ({
	identifier: "parent",
	targetType: "household",
	target,
	relationship,
});

function createOf(
	key: string,
	caseType: string,
	extra: Partial<CaseOperation> = {},
): CaseOperation {
	return {
		uuid: OP(key),
		id: key,
		action: "create",
		caseType,
		target: { kind: "new" },
		name: read("name"),
		links: [toOwn()],
		...extra,
	} as CaseOperation;
}
const own = (): CaseOperation =>
	({
		uuid: OWN,
		id: "own_case",
		action: "own",
		name: read("name"),
	}) as CaseOperation;

const toReview: FormLink["target"] = {
	type: "form",
	moduleUuid: VISITS,
	formUuid: VISIT_REVIEW,
};
const toHouseholdVisit: FormLink["target"] = {
	type: "form",
	moduleUuid: HOUSEHOLDS,
	formUuid: HOUSEHOLD_VISIT,
};

function datum(ref: Record<string, unknown>): Expression {
	return {
		kind: "term",
		term: { kind: "session-datum", datum: ref },
	} as Expression;
}

function carried(
	options: AdvancedFixtureOptions,
	links: FormLink[],
): ReturnType<typeof linkCarriedCreates> {
	const { doc, formUuid } = withLinks(options, links);
	return linkCarriedCreates(doc, formUuid);
}

function withLinks(
	options: AdvancedFixtureOptions,
	links: FormLink[],
): { doc: BlueprintDoc; formUuid: typeof UNDER_TEST } {
	const { doc, formUuid } = advancedFixture({
		heldKind: false,
		...options,
		configure: (d) => {
			const form = d.forms[UNDER_TEST];
			if (form !== undefined)
				d.forms[UNDER_TEST] = { ...form, formLinks: links as never };
			options.configure?.(d);
		},
	});
	return { doc, formUuid };
}

const registration = (
	...operations: CaseOperation[]
): AdvancedFixtureOptions => ({
	formType: "registration",
	operations: () => [own(), ...operations],
});

describe("linkCarriedCreates", () => {
	it("carries the create a matching link's target selects by case type", () => {
		expect([
			...carried(registration(createOf("visit", "visit")), [
				{ uuid: LINK, target: toReview },
			]),
		]).toEqual([OP("visit")]);
		expect(
			carriedCreateLinks(
				withLinks(registration(createOf("visit", "visit")), [
					{ uuid: LINK, target: toReview },
				]).doc,
				UNDER_TEST,
			),
		).toEqual(new Map([[OP("visit"), LINK]]));
	});

	it("carries the first create of the type, as HQ matches the first source datum", () => {
		expect([
			...carried(
				registration(createOf("first", "visit"), createOf("second", "visit")),
				[{ uuid: LINK, target: toReview }],
			),
		]).toEqual([OP("first")]);
	});

	it("carries the registration's own case to a form of its own type", () => {
		expect([
			...carried(registration(createOf("visit", "visit")), [
				{ uuid: LINK, target: toHouseholdVisit },
			]),
		]).toEqual([OWN]);
	});

	it("prefers a case the source selected over one it creates", () => {
		// A member chosen under its household: the household it selected is
		// the source datum the target's household matches first.
		const options: AdvancedFixtureOptions = {
			formType: "followup",
			menu: "members",
			operations: () => [createOf("household", "household", { links: [] })],
		};
		expect([
			...carried(options, [{ uuid: LINK, target: toHouseholdVisit }]),
		]).toEqual([]);
	});

	it("skips a root menu's placeholder for the case its first form creates", () => {
		// HQ copies the root's registration datum into the child entry only
		// as a placeholder, which never matches: the child form's own create
		// is the one carried.
		const options: AdvancedFixtureOptions = {
			formType: "registration",
			menu: "members",
			nested: true,
			operations: () => [
				{ ...own(), id: "member" } as CaseOperation,
				createOf("visit", "visit", { links: [] }),
			],
			configure: (d) => {
				// The root's first form registers a household and a visit under
				// it, whose datum HQ copies into the child entry.
				const root = d.forms[HOUSEHOLD_VISIT];
				if (root !== undefined)
					d.forms[HOUSEHOLD_VISIT] = {
						...root,
						type: "registration",
						caseOperations: [
							{ ...own(), uuid: OP("root-own"), id: "household" },
							{
								...createOf("root-visit", "visit"),
								links: [toOwn("child", { kind: "op", opUuid: OP("root-own") })],
							} as CaseOperation,
						],
					};
			},
		};
		expect([...carried(options, [{ uuid: LINK, target: toReview }])]).toEqual([
			OP("visit"),
		]);
	});

	it("carries what a link's condition and manual values read", () => {
		const links: FormLink[] = [
			{
				uuid: LINK,
				condition: datum({ kind: "new-case" }),
				target: toHouseholdVisit,
				datums: [
					{
						name: { kind: "selected-case", module: HOUSEHOLDS },
						xpath: datum({ kind: "new-case" }),
					},
				],
			},
			{
				uuid: LINK_B,
				target: toReview,
				datums: [
					{
						name: { kind: "selected-case", module: VISITS },
						xpath: datum({ kind: "new-child-case", caseType: "visit" }),
					},
				],
			},
		];
		const { doc } = withLinks(
			registration(createOf("first", "visit"), createOf("second", "visit")),
			links,
		);
		expect(carriedCreateLinks(doc, UNDER_TEST)).toEqual(
			new Map([
				[OWN, LINK],
				[OP("first"), LINK_B],
			]),
		);
	});

	it("never carries a create in a repeat or one keyed by an answer", () => {
		expect([
			...carried(
				registration(
					createOf("rowed", "visit", {
						name: read("kid_name"),
						forEach: { repeat: U("kids") },
					}),
					createOf("keyed", "visit", {
						target: { kind: "new", idFrom: U("name") },
					}),
				),
				[{ uuid: LINK, target: toReview }],
			),
		]).toEqual([]);
	});

	it("carries nothing into a flat menu, whose frame selects no case", () => {
		expect([
			...carried(registration(createOf("visit", "visit")), [
				{ uuid: LINK, target: { type: "module", moduleUuid: VISITS } },
			]),
		]).toEqual([]);
	});

	it("gives the same answer whatever kind the source and the target are emitted as", () => {
		const options = registration(
			createOf("ext", "visit", { links: [toOwn("extension")] }),
			createOf("visit", "visit"),
		);
		const links: FormLink[] = [
			{ uuid: LINK, target: toReview },
			{ uuid: LINK_B, target: toHouseholdVisit },
		];
		const basic = withLinks(options, links);
		const advanced = withLinks(
			{
				...options,
				configure: (d) => {
					for (const uuid of [HOUSEHOLDS, VISITS])
						d.modules[uuid] = { ...d.modules[uuid], heldKind: "advanced" };
				},
			},
			links,
		);
		expect([...linkCarriedCreates(basic.doc, UNDER_TEST)]).toEqual([
			OWN,
			OP("ext"),
		]);
		expect(carriedCreateLinks(advanced.doc, UNDER_TEST)).toEqual(
			carriedCreateLinks(basic.doc, UNDER_TEST),
		);
	});
});
