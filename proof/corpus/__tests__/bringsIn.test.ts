/**
 * A publish over a person's saves to an app's content in CommCare HQ does
 * what the document states: Nova's review of the change, its bring-in or its
 * record, a second review that finds nothing, and the publish that follows.
 *
 * Contract (`../publish.ts::capturePublish`, `bringInOverPeer`): over each
 * targeted document whose saves change the app's content
 * (`../../targeted/documents/hqChanges.ts`), the republish of D stops over a
 * change Nova can bring in, Nova's own review of it
 * (`lib/deployment/hqChanges/review.ts::checkHqChanges`) lists the change, the
 * bring-in takes exactly the stated document (`bringsIn`), a second review
 * finds the app unchanged, the record keeps the review's reading of the app
 * with an identity row for each of its forms (which the HQ side holds HQ's
 * own answer after the same saves to) and, for a file HQ holds under a path
 * its content does not derive, the asset the review read there, and the
 * publish that follows sends that document;
 * where the statement is `records`, the publish stops, the review finds
 * nothing to bring in for the stated reason and lists the stated changes of
 * the next publish, and the record lets the publish go; where it is
 * `proceeds`, the publish goes through with no stop, and a stop fails the
 * capture rather than being answered by a review. The plausible failures: a
 * peer that stores a save otherwise than HQ's view does (the review reads
 * another change, or none), a review, plan or bring-in that takes something
 * else (the stated document differs, which the capture names by its first
 * difference), a ledger the capture moves to somewhere other than the read
 * the review made, its files' record among it (the second review lists the
 * change again; the production record's own writes are held by
 * `lib/deployment/__tests__/hqChanges.postgres.test.ts`), a publish that
 * follows the bring-in under ids HQ does not hold (a form HQ added is sent
 * under Nova's derived `xmlns`), a stop over a `proceeds` document
 * passed off as a review that found nothing, and a review that lists other
 * changes of the next publish than a `brings-in` statement names
 * (`publishChanges`, which the lane's checks of that publish accept). The
 * observation is each capture's republish and its record.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { publishChangeSentences } from "@/lib/deployment/hqChanges/review";
import {
	hqChangesCaseManagement,
	hqChangesFormSetting,
	hqChangesForms,
	hqChangesLabel,
	hqChangesLocationList,
	hqChangesMedia,
	hqChangesMenu,
	hqChangesOrder,
	hqChangesQuestions,
	hqChangesResave,
} from "../../targeted/documents/hqChanges";
import { hqSideState } from "../../targeted/documents/hqSideState";
import type { CorpusDocument, HqSideSaves } from "../documents";
import { afterFirstPublish, hydrateAdmittedDocument } from "../editBatches";
import {
	capturePublish,
	documentVerdict,
	minimumConfiguration,
	type PublishDocument,
} from "../publish";

/** The first publish's document and the one every later publish sends, as the emission prepares them. */
function publishes(document: CorpusDocument): {
	readonly create: PublishDocument;
	readonly publish: PublishDocument;
} {
	const hydrated = hydrateAdmittedDocument({
		id: document.id,
		doc: document.doc,
		...(document.lookup !== undefined && { lookup: document.lookup }),
	});
	const beside = {
		...(document.lookup !== undefined && { lookup: document.lookup }),
		...(document.media !== undefined && { media: document.media }),
	};
	return {
		create: { id: document.id, doc: document.doc, compiledAtSeq: 1, ...beside },
		publish: {
			id: document.id,
			doc: afterFirstPublish(document.id, hydrated, document.lookup).doc,
			compiledAtSeq: 1,
			...beside,
		},
	};
}

async function republished(document: CorpusDocument) {
	const { create, publish } = publishes(document);
	const capture = await capturePublish({
		create,
		updates: [{ name: "republish", document: publish }],
		configuration: minimumConfiguration([documentVerdict(publish)]),
		...(document.hqSide !== undefined && { hqSide: document.hqSide }),
	});
	if (capture.status !== "sent") throw new Error(`${document.id} was refused.`);
	const step = capture.updates.republish;
	if (step?.status !== "sent")
		throw new Error(`${document.id}'s republish was not sent.`);
	return step;
}

describe("a publish over a person's saves to an app's content in CommCare HQ", () => {
	it.each([
		["the label", hqChangesLabel],
		["the questions", hqChangesQuestions],
		["the form's setting", hqChangesFormSetting],
		["the case management", hqChangesCaseManagement],
		["the menu", hqChangesMenu],
		["the forms", hqChangesForms],
		["the order", hqChangesOrder],
		["the replaced picture", hqChangesMedia],
	])(
		"brings %s in, finds nothing on a second review and sends the document the bring-in gave",
		async (_what, make) => {
			const document = make();
			const step = await republished(document);
			const record = step.broughtIn;
			expect(record?.review.kind).toBe("changes");
			expect(record?.taken).toBe("brought-in");
			expect(record?.discarded).toBe(false);
			expect(record?.again).toMatchObject({
				kind: "nothing",
				reason: "unchanged",
			});
			expect(record?.document).toEqual(document.hqSide?.bringsIn);
			// The review's reading of the app now, which the HQ side holds HQ's
			// own answer after the same saves to: a row for each of its forms.
			const reading = record?.reading;
			if (reading === undefined)
				throw new Error("The record keeps no reading of the review's.");
			const forms = Object.keys(reading.doc.forms);
			expect(forms.length).toBeGreaterThan(0);
			expect(
				forms.filter(
					(uuid) =>
						reading.identity.filter(
							(row) => row.entityKind === "form" && row.novaEntityUuid === uuid,
						).length !== 1,
				),
			).toEqual([]);
		},
		60_000,
	);

	it("records a form the form builder saved with no change as the same app, and lists nothing for the next publish", async () => {
		const step = await republished(hqChangesResave());
		expect(step.broughtIn?.review).toMatchObject({
			kind: "nothing",
			reason: "reads-the-same",
			publishChanges: [],
		});
		expect(step.broughtIn?.taken).toBe("recorded");
		expect(step.broughtIn?.again).toMatchObject({
			kind: "nothing",
			reason: "unchanged",
		});
	}, 60_000);

	it("refuses a document stating that its publish goes through with no stop, where the publish stops over the saves", async () => {
		const document = hqChangesLocationList();
		const {
			republish: _stated,
			recorded: _recorded,
			...saves
		} = document.hqSide ?? {};
		await expect(
			republished({
				...document,
				hqSide: { ...saves, republish: "proceeds" } as HqSideSaves,
			}),
		).rejects.toThrow(
			/proceeds over a person's saves in HQ, and it stopped with hq_changed/,
		);
	}, 60_000);

	it("goes through with no review over a person's saves Nova owns none of", async () => {
		const step = await republished(hqSideState());
		expect(step.broughtIn).toBeUndefined();
	}, 60_000);

	it("records the location list setting it reads as the same app, and lists what the next publish sets back", async () => {
		const step = await republished(hqChangesLocationList());
		expect(step.broughtIn?.review).toMatchObject({
			kind: "nothing",
			reason: "reads-the-same",
		});
		expect(step.broughtIn?.taken).toBe("recorded");
		expect(
			step.broughtIn?.review.kind === "nothing" &&
				step.broughtIn.review.publishChanges.length,
		).toBe(1);
		expect(step.broughtIn?.again).toMatchObject({
			kind: "nothing",
			reason: "unchanged",
		});
	}, 60_000);

	it("takes the picture a person replaced under its path, and the publish that follows sends it at the path its bytes derive", async () => {
		const document = hqChangesMedia();
		const step = await republished(document);
		const review = step.broughtIn?.review;
		expect(review?.kind).toBe("changes");
		expect(
			review?.kind === "changes" &&
				review.hqChanges.some((line) => /picture or sound/.test(line)),
		).toBe(true);
		/* The move of the picture's path is the next publish's to make, and the
		 * review says so before it. */
		expect(review?.kind === "changes" && review.publishChanges).toEqual(
			publishChangeSentences(["media-files-renamed"]),
		);
		const replaced = document.hqSide?.mediaReplaced;
		if (replaced === undefined) throw new Error("No picture is replaced.");
		const theirs = createHash("sha256")
			.update(Buffer.from(replaced.base64, "base64"))
			.digest("hex");
		const sent = JSON.stringify(step.application);
		expect(sent).toContain(`jr://file/commcare/${theirs}.png`);
		expect(sent).not.toContain(replaced.path);
		/* HQ holds the person's picture under Nova's path until that publish, so
		 * the review's reading names the slot by the asset of the person's bytes,
		 * which a read of HQ's answer after the same saves names that path by
		 * (proof 6's `saved` read). */
		const reading = step.broughtIn?.reading;
		const shown = Object.values(reading?.doc.fields ?? {}).flatMap((field) =>
			"label_media" in field && field.label_media?.image !== undefined
				? [field.label_media.image]
				: [],
		);
		const ofTheirBytes = [...(document.media ?? [])].flatMap(([id, asset]) =>
			Buffer.from(asset.bytes).toString("base64") === replaced.base64
				? [id]
				: [],
		);
		expect(ofTheirBytes).toHaveLength(1);
		expect(shown).toEqual(ofTheirBytes);
		expect(Object.keys(reading ?? {}).sort()).toEqual(["doc", "identity"]);
	}, 60_000);

	it("refuses a statement that names other changes of the next publish than the review lists", async () => {
		const document = hqChangesMedia();
		const hqSide = document.hqSide;
		if (hqSide?.republish !== "brings-in")
			throw new Error("The picture's statement does not bring the saves in.");
		await expect(
			republished({ ...document, hqSide: { ...hqSide, publishChanges: [] } }),
		).rejects.toThrow(/lists \[\] for the next publish, and it listed \["/);
	}, 60_000);

	it("publishes over a replaced picture only after it stops, and leaves HQ's map naming the document of Nova's own bytes", async () => {
		const step = await republished(hqChangesMedia());
		const over = step.publishedOver;
		expect(over?.stoppedOver).toHaveLength(1);
		expect(over?.stoppedOver[0]?.kind).toBe("app");
		expect(
			over?.stoppedOver[0]?.kind === "app" && over.stoppedOver[0].parts,
		).toEqual(["A picture or sound this app publishes"]);
		expect(Object.keys(over?.mapped ?? {})).toHaveLength(1);
	}, 60_000);
});
