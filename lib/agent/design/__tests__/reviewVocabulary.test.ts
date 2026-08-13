/**
 * The reviewer's symbol derivations — tag numbering over the citable set,
 * the bare-handle projection, positional finding handles, and the reserved
 * prefix. These are render-time projections, so what matters is that one
 * derivation is deterministic, deduped, and junk-tolerant; the lockstep with
 * the schema and the prompt is pinned in `designReview.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
	deriveFindingHandleBindings,
	projectBoundIdsToHandles,
	RESERVED_FINDING_HANDLE_PATTERN,
	sourceTagByRefKey,
	taggedCitableSourceRefs,
} from "@/lib/agent/design/reviewVocabulary";
import type { DesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import { did, imageRef, messageRef } from "./fixtures";

const ATTACHMENT_REF = {
	kind: "attachment-extract" as const,
	assetId: "00000000-0000-4000-8000-000000000860" as never,
	extractorVersion: 3,
	sectionPath: [],
};

function pkg(
	overrides: Partial<DesignSourcePackage> = {},
): DesignSourcePackage {
	return {
		schemaVersion: 1,
		designSessionId: "00000000-0000-4000-8000-000000000700",
		projectId: "project-1",
		packageDigest: "a".repeat(64),
		request: {
			blocks: [{ ref: messageRef(), text: "Track visits.", truncated: false }],
		},
		claims: [],
		attachments: [],
		images: [],
		platformConstraints: [],
		sources: [{ ref: messageRef() }],
		...overrides,
	};
}

describe("taggedCitableSourceRefs", () => {
	it("numbers the citable set in order, dedups, and skips platform refs", () => {
		const tagged = taggedCitableSourceRefs(
			pkg({
				sources: [
					{ ref: messageRef() },
					{ ref: ATTACHMENT_REF },
					{ ref: imageRef() },
				],
				claims: [
					{
						id: did(700),
						statement: "The user answered the pilot questions.",
						sourceRefs: [
							// A duplicate of the projected block, a platform fact, and
							// one genuinely new coordinate.
							messageRef(),
							{
								kind: "platform-constraint",
								code: "CASE_SEARCH_IS_LIVE_AND_ONLINE",
								sourceAnchor: "lib/commcare/suite/case-search/remoteRequest.ts",
							},
							messageRef(9),
						],
						status: "explicit",
						confidence: 1,
					},
				],
			}),
		);
		expect(tagged.map(({ tag, ref }) => [tag, ref.kind])).toEqual([
			["S1", "message"],
			["S2", "attachment-extract"],
			["S3", "image"],
			["S4", "message"],
		]);
	});

	it("keys the lookup by citation identity", () => {
		const tags = sourceTagByRefKey(pkg({ sources: [{ ref: messageRef() }] }));
		expect(tags.get("message:00000000-0000-4000-8000-999999999999:m1:0")).toBe(
			"S1",
		);
	});
});

describe("projectBoundIdsToHandles", () => {
	const bindings = [{ handle: "@patient", designId: did(20) as string }];

	it("replaces bound id strings with bare handles at any depth", () => {
		expect(
			projectBoundIdsToHandles(
				{
					id: did(20),
					nested: { list: [did(20), "keep-me"] },
				},
				bindings,
			),
		).toEqual({
			id: "@patient",
			nested: { list: ["@patient", "keep-me"] },
		});
	});

	it("passes unbound ids through raw", () => {
		expect(projectBoundIdsToHandles(did(21), bindings)).toBe(did(21));
	});

	it("walks junk without assuming a contract shape", () => {
		expect(projectBoundIdsToHandles({}, bindings)).toEqual({});
		expect(projectBoundIdsToHandles(null, bindings)).toBe(null);
		expect(projectBoundIdsToHandles([1, true, "x"], bindings)).toEqual([
			1,
			true,
			"x",
		]);
	});
});

describe("deriveFindingHandleBindings", () => {
	it("numbers findings continuously across reviews in the given order", () => {
		const bindings = deriveFindingHandleBindings([
			{ findings: [{ id: did(300) }, { id: did(301) }] },
			{ findings: [{ id: did(310) }] },
		]);
		expect(bindings).toEqual([
			{ handle: "@f1", designId: did(300), entityKind: "finding" },
			{ handle: "@f2", designId: did(301), entityKind: "finding" },
			{ handle: "@f3", designId: did(310), entityKind: "finding" },
		]);
	});

	it("derives nothing from an empty review set", () => {
		expect(deriveFindingHandleBindings([])).toEqual([]);
	});
});

describe("RESERVED_FINDING_HANDLE_PATTERN", () => {
	it("reserves exactly the server's finding numbering", () => {
		expect(RESERVED_FINDING_HANDLE_PATTERN.test("@f1")).toBe(true);
		expect(RESERVED_FINDING_HANDLE_PATTERN.test("@f27")).toBe(true);
		expect(RESERVED_FINDING_HANDLE_PATTERN.test("@f0")).toBe(false);
		expect(RESERVED_FINDING_HANDLE_PATTERN.test("@follow_up_visit")).toBe(
			false,
		);
		expect(RESERVED_FINDING_HANDLE_PATTERN.test("@form_intake")).toBe(false);
	});
});
