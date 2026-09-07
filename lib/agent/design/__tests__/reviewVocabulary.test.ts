import { describe, expect, it } from "vitest";
import { appDesignContractSchema } from "@/lib/agent/design/contract";
import { sourceRefKey } from "@/lib/agent/design/evidence";
import {
	designReservedHandleIssue,
	designReservedReferenceIssue,
} from "@/lib/agent/design/loop/tools";
import {
	deriveFindingHandleBindings,
	projectBoundIdsToHandles,
	sourceTagByRefKey,
	taggedCitableSourceRefs,
} from "@/lib/agent/design/reviewVocabulary";
import { EXTRACTOR_VERSION } from "@/lib/domain/multimedia";
import { did, fixtureValue, ids, makeContract } from "./fixtures";
import { reviewSourceFixture } from "./reviewSourceFixture";
import {
	SOURCE_DOCUMENT,
	SOURCE_IMAGE,
	SOURCE_PNG,
	SOURCE_THREAD,
	sourceDigest,
} from "./sourcePackageFixtures";

describe("review symbol projection", () => {
	it("assigns exact tags to the produced message, extract, image and answered-card coordinates", async () => {
		const pkg = await reviewSourceFixture();
		const before = structuredClone(pkg);
		const expected = [
			{
				tag: "S1",
				ref: {
					kind: "message",
					threadId: SOURCE_THREAD,
					messageId: "request",
					partIndex: 0,
				},
			},
			{
				tag: "S2",
				ref: {
					kind: "attachment-extract",
					assetId: SOURCE_DOCUMENT,
					extractorVersion: EXTRACTOR_VERSION,
					sectionPath: [],
				},
			},
			{
				tag: "S3",
				ref: {
					kind: "image",
					assetId: SOURCE_IMAGE,
					bytesDigest: sourceDigest(SOURCE_PNG),
				},
			},
			{
				tag: "S4",
				ref: {
					kind: "message",
					threadId: SOURCE_THREAD,
					messageId: "answers",
					partIndex: 1,
				},
			},
		];
		expect(taggedCitableSourceRefs(pkg)).toEqual(expected);
		expect([...sourceTagByRefKey(pkg)]).toEqual([
			[`message:${SOURCE_THREAD}:request:0`, "S1"],
			[`attachment:${SOURCE_DOCUMENT}:${EXTRACTOR_VERSION}`, "S2"],
			[`image:${SOURCE_IMAGE}:${sourceDigest(SOURCE_PNG)}`, "S3"],
			[`message:${SOURCE_THREAD}:answers:1`, "S4"],
		]);
		expect(pkg).toEqual(before);
		expect(taggedCitableSourceRefs(JSON.parse(JSON.stringify(pkg)))).toEqual(
			expected,
		);
	});

	it("deduplicates citation identity while retaining first coordinates in a defensive source projection", async () => {
		const pkg = await reviewSourceFixture();
		const original = taggedCitableSourceRefs(pkg);
		// The source-reference schema permits narrowed coordinates and platform refs.
		// The current answered-card producer only creates message claims.
		pkg.sources.push({
			ref: {
				kind: "attachment-extract",
				assetId: SOURCE_DOCUMENT,
				extractorVersion: EXTRACTOR_VERSION,
				sectionPath: ["Requirements"],
				figureMarker: '<nova:figure index="1"/>',
			},
		});
		pkg.sources.push({
			ref: {
				kind: "platform-constraint",
				code: "CASE_SEARCH_IS_LIVE_AND_ONLINE",
				sourceAnchor: "lib/commcare/suite/case-search/remoteRequest.ts",
			},
		});
		pkg.sources.push({
			ref: {
				kind: "image",
				assetId: SOURCE_IMAGE,
				bytesDigest: "f".repeat(64),
			},
		});
		expect(taggedCitableSourceRefs(pkg)).toEqual([
			...original.slice(0, 3),
			{
				tag: "S4",
				ref: {
					kind: "image",
					assetId: SOURCE_IMAGE,
					bytesDigest: "f".repeat(64),
				},
			},
			{ tag: "S5", ref: original[3]?.ref },
		]);
		expect(
			sourceTagByRefKey(pkg).get(
				sourceRefKey(
					fixtureValue(
						fixtureValue(pkg.claims[0], "claim").sourceRefs[0],
						"claim source",
					),
				),
			),
		).toBe("S5");
	});

	it("projects complete admitted contract references while preserving unrelated text and source data", () => {
		const contract = makeContract();
		const before = structuredClone(contract);
		const bindings = [
			{ handle: "@patient", designId: ids.recPatient },
			{ handle: "@patient_name", designId: ids.factName },
		];
		const result = projectBoundIdsToHandles(contract, bindings);
		const expected = JSON.parse(
			JSON.stringify(contract)
				.replaceAll(JSON.stringify(ids.recPatient), '"@patient"')
				.replaceAll(JSON.stringify(ids.factName), '"@patient_name"'),
		);
		expect(result).toEqual(expected);
		expect(contract).toEqual(before);
		expect(appDesignContractSchema.parse(contract)).toEqual(before);
	});

	it("handles defensive JSON values without losing own prototype-like keys or interpreting text fragments", () => {
		const input = JSON.parse(
			`{"__proto__":{"id":"${ids.recPatient}"},"constructor":[null,true,2,"${ids.recPatient}","prefix:${ids.recPatient}"],"unbound":"${ids.recVisit}"}`,
		);
		const before = JSON.stringify(input);
		expect(
			projectBoundIdsToHandles(input, [
				{ handle: "@patient", designId: ids.recPatient },
			]),
		).toEqual(
			JSON.parse(
				`{"__proto__":{"id":"@patient"},"constructor":[null,true,2,"@patient","prefix:${ids.recPatient}"],"unbound":"${ids.recVisit}"}`,
			),
		);
		expect(JSON.stringify(input)).toBe(before);
	});

	it("keeps positional findings continuous across empty reviews and later review appends", () => {
		const reviews = [
			{ findings: [{ id: did(300) }] },
			{ findings: [] },
			{ findings: [{ id: did(301) }, { id: did(302) }] },
		];
		expect(deriveFindingHandleBindings(reviews)).toEqual([
			{ handle: "@f1", designId: did(300), entityKind: "finding" },
			{ handle: "@f2", designId: did(301), entityKind: "finding" },
			{ handle: "@f3", designId: did(302), entityKind: "finding" },
		]);
		expect(
			deriveFindingHandleBindings([
				...reviews,
				{ findings: [{ id: did(303) }] },
			]),
		).toEqual([
			...deriveFindingHandleBindings(reviews),
			{ handle: "@f4", designId: did(303), entityKind: "finding" },
		]);
	});

	it.each(["@f1", "@f27"])(
		"refuses the reserved finding symbol %s at actual declaration and reference entry points",
		(handle) => {
			expect(
				designReservedHandleIssue(
					{
						collections: [
							{
								collection: "records",
								upserts: [
									{
										...fixtureValue(makeContract().records[0], "record"),
										id: { handle },
									},
								],
								removeIds: [],
							},
						],
					},
					"session",
				),
			).toContain(handle);
			expect(designReservedReferenceIssue({ recordId: { handle } })).toContain(
				handle,
			);
		},
	);
	it.each(["@f0", "@follow_up_visit", "@form_intake"])(
		"admits ordinary element symbol %s at those entry points",
		(handle) => {
			expect(
				designReservedHandleIssue(
					{
						collections: [
							{
								collection: "records",
								upserts: [
									{
										...fixtureValue(makeContract().records[0], "record"),
										id: { handle },
									},
								],
								removeIds: [],
							},
						],
					},
					"session",
				),
			).toBeNull();
			expect(designReservedReferenceIssue({ recordId: { handle } })).toBeNull();
		},
	);
});
