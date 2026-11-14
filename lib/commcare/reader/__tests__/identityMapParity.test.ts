/**
 * The keys a reading mints under are the keys the projection of its document
 * spells: for an app the reader reads, `draft.identities.entries` equals
 * `externalIdentityMap(doc, targetWireIdentity(rows))`, the rows being the
 * menu ids and `xmlns` the reading recorded.
 *
 * Catches a reader module that mints an entity under a key the projection
 * spells another way (another part order, another ordinal, another kind), or
 * an entity one side holds and the other does not: the two readings of a
 * change made in CommCare HQ would then bind different entities to one key.
 *
 * Over the retained sources of CommCare HQ's apps under `proof/hq-reads/`
 * (the reading group's and the apps HQ's own pages saved), where the reader
 * reads them, and over Nova's own export, which reads.
 */
import { describe, expect, it } from "vitest";
import {
	type RetainedHqAnswer,
	retainedBodyJson,
	retainedGroupRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import {
	targetWireIdentity,
	type WireIdentityOverride,
} from "../../wireIdentity";
import { externalKeyText, type IdentityMapEntry } from "../identity";
import { externalIdentityMap } from "../identityMap";
import { readHqApp } from "../index";
import type { ReadDraft } from "../types";
import { exportedBody, inputFor } from "./novaExport";
import { readerInput, sourceFromBody } from "./readerInput";

function byKey(
	entries: readonly IdentityMapEntry[],
): readonly IdentityMapEntry[] {
	return [...entries].sort((a, b) => {
		const left = externalKeyText(a);
		const right = externalKeyText(b);
		return left < right ? -1 : left > right ? 1 : 0;
	});
}

/** The identity rows a reading records: each menu's id and each form's `xmlns`. */
function rowsOf(draft: ReadDraft): WireIdentityOverride[] {
	return [
		...draft.identities.modules.map(
			(module): WireIdentityOverride => ({
				entityKind: "module",
				novaEntityUuid: module.uuid,
				uniqueId: module.uniqueId,
				xmlns: null,
			}),
		),
		...draft.identities.forms.map(
			(form): WireIdentityOverride => ({
				entityKind: "form",
				novaEntityUuid: form.uuid,
				uniqueId: null,
				xmlns: form.xmlns,
			}),
		),
	];
}

function expectParity(draft: ReadDraft): void {
	expect(byKey(draft.identities.entries)).toEqual(
		byKey(externalIdentityMap(draft.doc, targetWireIdentity(rowsOf(draft)))),
	);
}

/** Two menus of questions, a group and choices among them. */
function surveys(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Intake",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({ kind: "text", id: "name", label: "Name" }),
							f({
								kind: "group",
								id: "home",
								label: "Home",
								children: [f({ kind: "int", id: "rooms", label: "Rooms" })],
							}),
						],
					},
					{
						name: "Follow up",
						type: "survey",
						fields: [
							f({
								kind: "single_select",
								id: "status",
								label: "Status",
								options: [
									{ value: "well", label: "Well" },
									{ value: "ill", label: "Ill" },
								],
							}),
						],
					},
				],
			},
			{
				name: "Feedback",
				forms: [
					{
						name: "Rate",
						type: "survey",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
		],
	});
}

/** Every retained answer that is an app's source. */
const RETAINED_SOURCES: readonly [string, () => RetainedHqAnswer][] = [
	["reading/source-shadow", () => retainedReadingRead("source-shadow")],
	...[
		"hq-built/app-source",
		"navigation-base/app-source",
		"navigation-base/app-source-after-form-builder-save",
		"case-list-inline/app-source",
	].map((file): [string, () => RetainedHqAnswer] => [
		file,
		() => retainedGroupRead(file),
	]),
];

describe("the keys a reading mints", () => {
	it("are the keys the projection of Nova's own export spells", async () => {
		const outcome = readHqApp(await inputFor(exportedBody(surveys())));
		expect(outcome.kind).toBe("read");
		if (outcome.kind === "read") {
			expect(outcome.draft.identities.entries.length).toBeGreaterThan(0);
			expectParity(outcome.draft);
		}
	});

	for (const [name, answer] of RETAINED_SOURCES)
		it(`are the keys the projection spells for ${name}, where it reads`, async () => {
			const body = retainedBodyJson(answer());
			const outcome = readHqApp({
				...readerInput(await sourceFromBody(body)),
				recordDialect: () => undefined,
			});
			if (outcome.kind === "read") expectParity(outcome.draft);
			else expect(outcome.findings.length).toBeGreaterThan(0);
		});
});
