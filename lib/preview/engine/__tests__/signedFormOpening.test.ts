import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type {
	FormOpeningAudience,
	FormOpeningProjection,
} from "../formOpeningSnapshot";
import { serverPreviewDevice } from "../previewDevice";
import { signFormOpening, verifyFormOpening } from "../signedFormOpening";

const audience: FormOpeningAudience = {
	app: "visit",
	project: "district-a",
	actor: "member",
	session: "signed-in-session",
	worker: "worker-a",
	persona: null,
	device: serverPreviewDevice({ platform: "web-apps", appLanguage: "en" }),
	run: testUuid("run"),
	module: testUuid("menu"),
	form: testUuid("form"),
	entry: testUuid("form-entry"),
	revision: 1,
	blueprintDigest: "1".repeat(64),
};
const projection: FormOpeningProjection = {
	cases: { rows: [], indices: [] },
	lookup: { projectRevision: "1", definitions: [], rowsByTable: {} },
	choices: [{ selection: testUuid("choice"), caseId: "record-a" }],
	primaryCaseIds: ["record-a"],
	sessionData: {},
	datums: { selected: "record-a" },
	resolvedEntries: {},
	complete: true,
};
const secret = "synthetic entry signing secret";

describe("the authorized running form's immutable opening", () => {
	it("rehydrates its exact opening and rejects cross-session, cross-entry, cross-project and changed payloads", async () => {
		const signed = await signFormOpening(secret, audience, projection);
		await expect(verifyFormOpening(secret, audience, signed)).resolves.toEqual(
			projection,
		);
		await expect(
			verifyFormOpening(secret, audience, {
				...signed,
				content: signed.content.replaceAll("record-a", "record-b"),
			}),
		).rejects.toThrow(/Reopen/);
		for (const changes of [
			{ app: "other" },
			{ project: "other" },
			{ session: "other" },
			{ worker: "other" },
			{ actor: "other" },
			{ persona: "other" },
			{
				device: {
					...audience.device,
					androidDeviceId: testUuid("different device"),
				},
			},
			{ module: testUuid("other menu") },
			{ form: testUuid("other form") },
			{ entry: testUuid("other entry") },
			{ run: testUuid("next preview run") },
			{ revision: 2 },
			{ blueprintDigest: "0".repeat(64) },
		])
			await expect(
				verifyFormOpening(secret, { ...audience, ...changes }, signed),
			).rejects.toThrow(/Reopen/);
	});
});
