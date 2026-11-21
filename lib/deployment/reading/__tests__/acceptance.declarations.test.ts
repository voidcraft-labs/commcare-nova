/**
 * Acceptance judges every declaration the review will offer.
 *
 * Contract: a reading offering a choice the gate refuses fails the gate
 * though its other choices pass, since the person may pick any choice
 * offered; a reading whose one file plays in Web Apps only, with its choices
 * as project data narrows them, answers `ok` with no declaration that
 * includes Android, the first choice left preselected, and the reading's
 * first-publish list that choice's; a reading with a split offered makes two
 * re-reads in one call, the reading's document and the split document, and
 * passes; and two held files of one content at two paths give every choice
 * the same first-publish list, `media-paths-joined` among it, whether the
 * reading names them by two provisional ids or by one published id; and a
 * reading is printed for its fixed point under the declaration it proposes,
 * so a case list first in an app that runs only on Android reads back.
 *
 * Plausible failures: a birth that applies a choice nobody checked; an app
 * with a Web-Apps-only file refused as Nova's mistake; a split whose
 * questions get new uuids on the re-read; a review that shows a list the
 * birth does not store, so a correct app fails the create's integrity check;
 * a reading printed with Web Apps on whatever its declaration, so a list
 * first it holds reads back refused.
 */

import { describe, expect, it, vi } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { ReaderInput, readHqApp } from "@/lib/commcare/reader";
import { mintingResolver } from "@/lib/commcare/reader/identity";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import { PLATFORM_FEATURE_FIXTURES } from "@/lib/domain/__tests__/platformFeatureFixtures";
import { acceptReading } from "../acceptance";
import { narrowDeclarationsByMedia } from "../projectData/media";
import { acceptanceInput, NO_TABLES } from "./acceptanceInput";
import {
	type ServedFile,
	servedMediaReading,
	servedReading,
	servedSource,
} from "./servedReading";

const reads = vi.hoisted(() => ({
	count: 0,
	/** Each re-read's input and answer, in the order acceptance made them. */
	calls: [] as {
		readonly input: ReaderInput;
		readonly outcome: ReturnType<typeof readHqApp>;
	}[],
	actual: undefined as typeof readHqApp | undefined,
}));

vi.mock("@/lib/commcare/reader", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/commcare/reader")>();
	reads.actual = actual.readHqApp;
	return {
		...actual,
		/* Acceptance re-reads a stage at a time. */
		readHqAppSteps: function* (
			...args: Parameters<typeof actual.readHqAppSteps>
		) {
			reads.count++;
			const outcome = yield* actual.readHqAppSteps(...args);
			reads.calls.push({ input: args[0], outcome });
			return outcome;
		},
	};
});

/** The question uuids of a re-read's document, sorted. */
function questionUuids(outcome: ReturnType<typeof readHqApp>): string[] {
	if (outcome.kind !== "read")
		throw new Error("The re-read read to an account.");
	return Object.keys(outcome.draft.doc.fields).sort();
}

const SEEN = buildDoc({
	appName: "Clinic",
	modules: [
		{
			name: "Visits",
			forms: [
				{
					name: "Visit",
					type: "survey",
					fields: [f({ kind: "datetime", id: "seen_at" })],
				},
			],
		},
	],
});

const NO_TABLES_CONTEXT: LookupValidationContext = {
	kind: "available",
	projectId: NO_TABLES.projectId,
	projectRevision: NO_TABLES.projectRevision,
	definitions: [],
};

function accepted(input: Parameters<typeof acceptReading>[0]) {
	const answer = acceptReading(input);
	if (!answer.ok)
		throw new Error(
			`${answer.check}: ${answer.differences.map((one) => `${one.signature} ${one.detail}`).join("\n")}`,
		);
	return answer;
}

describe("acceptReading's declarations", () => {
	it("fails the gate for one choice the gate refuses, whatever the others do", async () => {
		const read = servedReading(await servedSource(SEEN));
		const input = acceptanceInput(read.reader, read.outcome);
		expect(input.choices.choices.length).toBeGreaterThan(1);
		accepted(input);

		const doc = read.outcome.draft.doc;
		const field = Object.values(doc.fields)[0];
		if (field === undefined) throw new Error("The reading holds a question.");
		const refusedId = diffDocsToMutations(doc, {
			...doc,
			fields: { ...doc.fields, [field.uuid]: { ...field, id: "1seen" } },
		});
		const choices = input.choices.choices.map((choice, index) =>
			index === 0
				? { ...choice, mutations: [...choice.mutations, ...refusedId] }
				: choice,
		);
		const answer = acceptReading({
			...input,
			choices: { ...input.choices, choices },
		});
		expect(answer.ok).toBe(false);
		if (!answer.ok) expect(answer.check).toBe("gate");
	});

	it("accepts a Web-Apps-only file over the choices project data leaves", async () => {
		const icon = testMediaAssetId("icon");
		const read = await servedMediaReading(
			buildDoc({
				appName: "Clinic",
				modules: [
					{
						name: "Visits",
						forms: [
							{
								name: "Visit",
								type: "survey",
								fields: [
									f({ kind: "text", id: "q", label_media: { image: icon } }),
								],
							},
						],
					},
				],
			}),
			[
				{
					path: "jr://file/commcare/icon.png",
					assetId: icon,
					contentHash: "a".repeat(64),
					mediaFormat: "ico",
					mimeType: "image/vnd.microsoft.icon",
				},
			],
		);
		const choices = narrowDeclarationsByMedia(read.outcome.draft.declaration, [
			"web-apps",
		]);
		if (choices.kind !== "choices")
			throw new Error("A Web Apps choice is left.");
		const answer = accepted(
			acceptanceInput(read.reader, read.outcome, {
				choices,
				media: read.media,
			}),
		);
		expect(answer.declarations.map((one) => one.runsOnlyOn)).toEqual(
			choices.choices.map(() => "web-apps"),
		);
		expect(answer.declarations[choices.proposed]?.preselected).toBe(true);
		expect(answer.firstPublish).toEqual(
			answer.declarations[choices.proposed]?.firstPublish,
		);
	});

	it("re-reads the reading's document and the split document in one call", async () => {
		const read = servedReading(await servedSource(SEEN));
		const input = acceptanceInput(read.reader, read.outcome);
		expect(input.choices.choices.some((choice) => choice.split)).toBe(true);
		reads.count = 0;
		reads.calls.length = 0;
		accepted(input);
		expect(reads.count).toBe(2);

		/* The reading's document is read again under a fresh minting
		 * resolver, which gives it the uuids the reading gave it; the split
		 * document under the matching resolver, which keeps the uuids the
		 * split gave its new questions. A minting resolver mints others for
		 * them, so the split re-read would differ at every question. */
		const [again, splitAgain] = reads.calls;
		if (again === undefined || splitAgain === undefined)
			throw new Error("Acceptance made both re-reads.");
		expect(questionUuids(again.outcome)).toEqual(
			Object.keys(read.outcome.draft.doc.fields).sort(),
		);
		const split = input.choices.choices.find((choice) => choice.split);
		if (split === undefined) throw new Error("The reading offers the split.");
		const splitDoc = mutationCommitVerdict(
			read.outcome.draft.doc,
			split.mutations,
			NO_TABLES_CONTEXT,
		).nextDoc;
		expect(questionUuids(splitAgain.outcome)).toEqual(
			Object.keys(splitDoc.fields).sort(),
		);
		const actual = reads.actual;
		if (actual === undefined)
			throw new Error("The reader is mocked over itself.");
		expect(
			questionUuids(
				actual({ ...splitAgain.input, resolver: mintingResolver(input.appId) }),
			),
		).not.toEqual(Object.keys(splitDoc.fields).sort());

		const unsplit = {
			...input,
			choices: {
				...input.choices,
				choices: input.choices.choices.filter((choice) => !choice.split),
				proposed: 0,
			},
		};
		reads.count = 0;
		accepted(unsplit);
		expect(reads.count).toBe(1);
	});

	it("prints the reading under its proposed declaration, so a case list first reads back", async () => {
		const doc = PLATFORM_FEATURE_FIXTURES["list-first"].with();
		expect(doc.appSettings.runsOnlyOn).toBe("android");
		const read = servedReading(await servedSource(doc));
		expect(read.reader.source.cloudcareEnabled).toBe(false);
		const input = acceptanceInput(read.reader, read.outcome);
		expect(
			input.choices.choices.map((choice) => choice.runsOnlyOn),
		).not.toContain(undefined);
		reads.calls.length = 0;
		accepted(input);
		const [again] = reads.calls;
		if (again === undefined) throw new Error("Acceptance made the re-read.");
		expect(again.input.source.cloudcareEnabled).toBe(false);
	});

	it("gives every choice one list for two files of one content, by provisional or published ids", async () => {
		const first = testMediaAssetId("first");
		const second = testMediaAssetId("second");
		const doc = buildDoc({
			appName: "Clinic",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({ kind: "text", id: "a", label_media: { image: first } }),
								f({ kind: "text", id: "b", label_media: { image: second } }),
							],
						},
					],
				},
			],
		});
		const files: ServedFile[] = [
			{
				path: "jr://file/commcare/a.png",
				assetId: first,
				contentHash: "c".repeat(64),
				mediaFormat: "png",
				mimeType: "image/png",
			},
			{
				path: "jr://file/commcare/b.png",
				assetId: second,
				contentHash: "c".repeat(64),
				mediaFormat: "png",
				mimeType: "image/png",
			},
		];
		const lists = async (reading?: (path: string) => typeof first) => {
			const read = await servedMediaReading(
				doc,
				files,
				reading === undefined ? undefined : { reading },
			);
			return accepted(
				acceptanceInput(read.reader, read.outcome, { media: read.media }),
			).declarations.map((one) => one.firstPublish);
		};
		const provisional = await lists();
		const published = await lists(() => testMediaAssetId("published"));
		expect(provisional).toEqual(published);
		for (const list of provisional)
			expect(list.ids).toContain("media-paths-joined");
	});
});
