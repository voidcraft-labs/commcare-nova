/**
 * What a download says about itself.
 *
 * The line these tests hold is that an advisory is never a refusal and never
 * a fabrication: an export with no CommCare HQ project space behind it still
 * succeeds, still carries every question, and says plainly which case
 * properties it left unfilled. The inverse matters just as much — an app with
 * no attachment links, or one published to exactly one project space, must
 * say nothing at all, because a notice that fires on every download is a
 * notice nobody reads.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain/prose";
import {
	decodeExportAdvisories,
	encodeExportAdvisories,
	exportAdvisories,
} from "../exportAdvisories";

function docWithCaptures(
	captures: ReadonlyArray<{ id: string; property: string }>,
) {
	return buildDoc({
		appName: "Attachments",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					...captures.map((capture) => ({
						name: capture.property,
						label: proseText(capture.property),
					})),
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "full_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							...captures.map((capture) =>
								f({
									kind: "image",
									id: capture.id,
									label: proseText(capture.id),
									caseWrite: {
										caseType: "patient",
										property: capture.property,
										mode: "url",
									},
								}),
							),
						],
					},
				],
			},
		],
	});
}

describe("exportAdvisories", () => {
	it("names the case properties a targetless download leaves unfilled", () => {
		const doc = docWithCaptures([
			{ id: "photo", property: "photo_url" },
			{ id: "consent", property: "consent_url" },
		]);
		const [advisory, ...rest] = exportAdvisories(doc, "none");

		expect(rest).toEqual([]);
		expect(advisory?.id).toBe("attachment_links_without_target");
		// The properties are named, in a stable order, because "some links are
		// missing" is not something a person can act on.
		expect(advisory?.message).toContain(
			"The case properties consent_url and photo_url each hold",
		);
		// Plural subject, plural pronoun. A mismatch here reads as machine
		// output in the one place the reader is already unsure what happened.
		expect(advisory?.message).toContain("fills them in");
		expect(advisory?.message).toContain("has not reached a CommCare project");
	});

	it("uses the singular when one property is affected", () => {
		const doc = docWithCaptures([{ id: "photo", property: "photo_url" }]);
		const message = exportAdvisories(doc, "none")[0]?.message ?? "";
		expect(message).toContain("The case property photo_url holds");
		expect(message).toContain("fills it in");
		expect(message).not.toContain("fills them in");
	});

	it("says which question the person is actually facing", () => {
		// Two project spaces is not "not published yet", and telling somebody
		// to publish would be the wrong next step.
		const doc = docWithCaptures([{ id: "photo", property: "photo_url" }]);
		const message = exportAdvisories(doc, "ambiguous")[0]?.message ?? "";
		expect(message).toContain("More than one CommCare project space");
		expect(message).not.toContain("has not reached");
	});

	it("says nothing when the links have somewhere to point", () => {
		const doc = docWithCaptures([{ id: "photo", property: "photo_url" }]);
		expect(exportAdvisories(doc, "known")).toEqual([]);
	});

	it("says nothing about an app with no attachment links", () => {
		// A capture that saves nowhere loses nothing by being downloaded.
		const doc = docWithCaptures([]);
		expect(exportAdvisories(doc, "none")).toEqual([]);
		expect(exportAdvisories(doc, "ambiguous")).toEqual([]);
	});
});

describe("the export header", () => {
	it("survives the trip through a response header", () => {
		const doc = docWithCaptures([{ id: "photo", property: "photo_url" }]);
		const advisories = exportAdvisories(doc, "none");
		expect(decodeExportAdvisories(encodeExportAdvisories(advisories))).toEqual(
			advisories,
		);
	});

	it("reads unreadable metadata as nothing to say, never as a failure", () => {
		// The bytes already arrived by the time this is read. Nothing here is
		// worth turning a finished download into an error.
		expect(decodeExportAdvisories(null)).toEqual([]);
		expect(decodeExportAdvisories("")).toEqual([]);
		expect(decodeExportAdvisories("%%%not-encoded")).toEqual([]);
		expect(decodeExportAdvisories(encodeURIComponent("[1,2,3]"))).toEqual([]);
		expect(
			decodeExportAdvisories(
				encodeURIComponent(
					JSON.stringify([{ id: "made_up", title: "x", message: "y" }]),
				),
			),
		).toEqual([]);
	});
});
