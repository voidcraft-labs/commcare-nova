/**
 * An advanced load's `case_properties` key written through an index
 * (`parent/remark`).
 *
 * Contract: HQ's build writes such a key of a load into a block of the case
 * its index steps reach from the load's own case (`xform.py::
 * XForm._add_case_updates`, one `index/<segment>` a step,
 * `get_case_parent_id_xpath`), and HQ's page offers it on every load not
 * chosen under another (`advanced/case_properties.js`). On the form's own
 * load with no `case_index`, steps each `parent` or `host` are the own case's
 * write through `via`, which Nova's emitter prints back as the same key
 * (`casePlacementPlan.ts::planFormCaseWire`'s update map): the reading holds
 * it with no finding, into a document the commit gate admits. The first
 * manually chosen case may also write through a declared parent or host.
 * Other load positions, unsupported index names, and index destinations
 * whose case type is unknown get a finding at their key
 * (`index-path-through-a-case-type-the-app-does-not-fix`). A key HQ's
 * server stores apart (`location_id`) is the case above's write as any other
 * key is, and its `name` and `owner_id` are writes of the case above's
 * `case_name` and `owner_id` (`update-key-name-or-owner-id-through-an-index-
 * segment`), which Nova's export writes back as the same keys.
 *
 * The plausible failures: Nova's own export of a write through the own case's
 * parent read as `unrecognized` (what the reader did before), or such a key
 * on another load read as the own case's write.
 */
import { describe, expect, it } from "vitest";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, CaseOperation } from "@/lib/domain";
import {
	advancedFixture,
	OP,
	read,
} from "../../../__tests__/advancedPlacementFixture";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf } from "../../index";
import { readHqApp } from "./heldReading";

const F = "forms-and-case-writes";
const ELSEWHERE = `${F}/loadupdateaction-case-properties-key-with-on-a-load-with-no-case`;
const UNKNOWN = `${F}/index-path-through-a-case-type-the-app-does-not-fix`;

/** A follow-up of visits, chosen on their own, that writes its visit's
 *  household's remark through the visit's parent link. */
function throughParent(): BlueprintDoc {
	return advancedFixture({
		formType: "followup",
		menu: "visits",
		operations: (): CaseOperation[] => [
			{
				uuid: OP("own"),
				id: "visit",
				action: "own",
				writes: [
					{
						property: "remark",
						value: read("name"),
						via: [{ identifier: "parent", throughCaseType: "household" }],
					},
				],
			},
		],
	}).doc;
}

/** A follow-up of members, chosen under their household: two loads, the
 *  household's first and with no `case_index`. */
function memberFollowup(): BlueprintDoc {
	return advancedFixture({
		formType: "followup",
		menu: "members",
		operations: (): CaseOperation[] => [
			{
				uuid: OP("own"),
				id: "member",
				action: "own",
				writes: [{ property: "age", value: read("age") }],
			},
		],
	}).doc;
}

type Load = Record<string, unknown> & {
	case_properties: Record<string, unknown>;
};

/** The stored loads of the form under test. */
function loadsOf(body: Record<string, unknown>): Load[] {
	for (const module of body.modules as { forms: Record<string, unknown>[] }[])
		for (const form of module.forms)
			if (JSON.stringify(form.name).includes("Under test"))
				return (form.actions as { load_update_cases: Load[] })
					.load_update_cases;
	throw new Error("The app holds the form under test.");
}

/** A whole reading of `doc`'s export with `edit` applied to its loads, told
 *  what a re-read is told where `known`. */
async function reading(
	doc: BlueprintDoc,
	edit: (loads: Load[]) => void = () => {},
	known = true,
) {
	const body = exportedBody(doc, {
		modules: (modules) => {
			edit(loadsOf({ modules }));
			return modules;
		},
	});
	return readHqApp(
		await inputFor(body, {
			resolver: matchingResolver(
				doc.appId,
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			...(known && { knownCaseTypes: knownCaseTypesOf(doc) }),
		}),
	);
}

/** The own load's one key, renamed to `key`. */
function ownKey(key: string) {
	return (loads: Load[]) => {
		const own = loads[loads.length - 1] as Load;
		const [value] = Object.values(own.case_properties);
		own.case_properties = { [key]: value };
	};
}

describe("a write through the own load's parent link", () => {
	it("reads Nova's own export of it back whole, with no finding, into a document the gate admits", async () => {
		const doc = throughParent();
		// The document is one the gate admits, and its export writes the key HQ's build reads.
		const admitted = mutationCommitVerdict(doc, [], LOOKUP_CONTEXT_UNAVAILABLE);
		expect(admitted.ok ? [] : admitted.findings).toEqual([]);
		const [own] = loadsOf(exportedBody(doc));
		expect(Object.keys(own?.case_properties ?? {})).toEqual(["parent/remark"]);

		const outcome = await reading(doc);
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		const want = READER_CANONICAL_CHOICES.reduce(
			(current, choice) => choice.apply(current),
			doc,
		);
		const operations = (one: BlueprintDoc) =>
			Object.values(one.forms).find((form) => form.name === "Under test")
				?.caseOperations;
		expect(operations(outcome.draft.doc)).toEqual(operations(want));
		const verdict = mutationCommitVerdict(
			outcome.draft.doc,
			[],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	});

	it("refuses it where nothing in the app fixes the case type the link reaches", async () => {
		const outcome = await reading(throughParent(), undefined, false);
		expect(outcome.defects).toEqual([]);
		const codes = outcome.kind === "account" ? outcome.findings : [];
		expect(codes.map((one) => one.code)).toEqual([UNKNOWN]);
		expect(codes[0]?.detail?.name).toBe("parent/remark");
	});

	for (const [key, property] of [
		["parent/name", "case_name"],
		["parent/owner_id", "owner_id"],
	] as const)
		it(`reads \`${key}\` on the own load as the case above's ${property}, and writes it back as the same key`, async () => {
			const outcome = await reading(throughParent(), ownKey(key));
			expect(outcome.defects).toEqual([]);
			expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
			if (outcome.kind !== "read") throw new Error("The export did not read.");
			const doc = outcome.draft.doc;
			const writes = Object.values(doc.forms).find(
				(form) => form.name === "Under test",
			)?.caseOperations?.[0]?.writes;
			expect(writes?.map((write) => [write.property, write.via])).toEqual([
				[property, [{ identifier: "parent", throughCaseType: "household" }]],
			]);
			const verdict = mutationCommitVerdict(
				doc,
				[],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(verdict.ok ? [] : verdict.findings).toEqual([]);
			const [own] = loadsOf(exportedBody(doc)).slice(-1);
			expect(Object.keys(own?.case_properties ?? {})).toEqual([key]);
		});

	for (const [key, entry] of [
		["user/remark", ELSEWHERE],
		["home/remark", ELSEWHERE],
	] as const)
		it(`refuses \`${key}\` on the own load once, at its key`, async () => {
			const outcome = await reading(throughParent(), ownKey(key));
			expect(outcome.defects).toEqual([]);
			const findings = outcome.kind === "account" ? outcome.findings : [];
			expect(findings.map((one) => one.code)).toEqual([entry]);
			expect(findings[0]?.detail?.name).toBe(key);
		});

	it("reads `parent/location_id` on the own load as the case above's location", async () => {
		const outcome = await reading(
			throughParent(),
			ownKey("parent/location_id"),
		);
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		const writes = Object.values(outcome.draft.doc.forms).find(
			(form) => form.name === "Under test",
		)?.caseOperations?.[0]?.writes;
		expect(writes?.map((write) => [write.property, write.via])).toEqual([
			["location_id", [{ identifier: "parent", throughCaseType: "household" }]],
		]);
	});

	it("refuses an unknown parent type on the first manually chosen case", async () => {
		// The household's load, first of the chain, chosen with no `case_index`.
		const outcome = await reading(memberFollowup(), (loads) => {
			const own = loads[loads.length - 1] as Load;
			const household = loads[0] as Load;
			const [value] = Object.values(own.case_properties);
			household.case_properties = { "parent/remark": value };
		});
		expect(outcome.defects).toEqual([]);
		const findings = outcome.kind === "account" ? outcome.findings : [];
		expect(findings.map((one) => one.code)).toEqual([UNKNOWN]);
		expect(findings[0]?.detail?.name).toBe("parent/remark");
	});
});
