/** Pure: which reached deployment a download is made for, and each refusal's copy. */
import { describe, expect, it } from "vitest";
import {
	chooseDownloadTarget,
	downloadRefusalLines,
	type ReachedDeploymentTarget,
} from "../runtimeTarget";

const US_ACME: ReachedDeploymentTarget = {
	server: "production",
	domain: "acme",
	hqAppId: "0123456789abcdef0123456789abcdef",
};
const INDIA_ACME: ReachedDeploymentTarget = {
	server: "india",
	domain: "acme",
	hqAppId: "11111111111111111111111111111111",
};
const INDIA_FIELD: ReachedDeploymentTarget = {
	server: "india",
	domain: "field-ops",
	hqAppId: "22222222222222222222222222222222",
};
const REACHED = [US_ACME, INDIA_ACME, INDIA_FIELD];

const NEEDS_PUBLISHED =
	"A CCZ signs workers in to one project space and sends their forms there, so it is made for a project space this app is published to. Once the app is published, you can download the CCZ for that space.";
const PICK =
	"A CCZ signs workers in to one project space and sends their forms there. This app is published to several, so you can pick the one this CCZ is for.";
const HELD =
	"A CCZ signs workers in to one project space and sends their forms there, so it is made for a project space this app is published to. This app can't be published to CommCare HQ as it is, so it has no CCZ yet.";
const NOT_FOR_IMPORT_FILE =
	"The CommCare HQ import file works in any project space, so it isn't made for one. You can download it again without a project space.";
const unknown = (named: string) =>
	`This app isn't published to ${named}, so there's no CCZ for it there. You can pick one of the project spaces it's published to.`;
const EVERY_SPACE = ["acme on US", "acme on India", "field-ops on India"];

describe("chooseDownloadTarget for a CCZ", () => {
	it("refuses an app published nowhere, whatever it names", () => {
		for (const input of [
			{},
			{ server: "india" as const },
			{ domain: "acme" },
			{ heldFromHq: [] },
		]) {
			const choice = chooseDownloadTarget([], { format: "ccz", ...input });
			expect(choice).toEqual({
				kind: "refused",
				reason: "needs-published-project-space",
				message: NEEDS_PUBLISHED,
				reached: [],
				heldFromHq: [],
			});
			if (choice.kind === "refused")
				expect(downloadRefusalLines(choice)).toEqual([]);
		}
	});

	it("says why an app holding a selection CommCare HQ cannot take has no CCZ", () => {
		const held = ['"Child care" reads several parents.'];
		const choice = chooseDownloadTarget([], {
			format: "ccz",
			domain: "acme",
			heldFromHq: held,
		});
		expect(choice).toEqual({
			kind: "refused",
			reason: "selection-held-from-hq",
			message: HELD,
			reached: [],
			heldFromHq: held,
		});
		if (choice.kind === "refused")
			expect(downloadRefusalLines(choice)).toEqual(held);
	});

	it("takes a reached deployment whatever the held lines say", () => {
		expect(
			chooseDownloadTarget([US_ACME], {
				format: "ccz",
				heldFromHq: ["a line"],
			}),
		).toEqual({ kind: "project-space", target: US_ACME });
	});

	it("takes the only deployment there is, or the one the inputs name", () => {
		expect(chooseDownloadTarget([INDIA_FIELD], { format: "ccz" })).toEqual({
			kind: "project-space",
			target: INDIA_FIELD,
		});
		expect(
			chooseDownloadTarget(REACHED, { format: "ccz", domain: "field-ops" }),
		).toEqual({ kind: "project-space", target: INDIA_FIELD });
		expect(
			chooseDownloadTarget(REACHED, {
				format: "ccz",
				domain: "acme",
				server: "india",
			}),
		).toEqual({ kind: "project-space", target: INDIA_ACME });
		expect(
			chooseDownloadTarget(REACHED, { format: "ccz", server: "production" }),
		).toEqual({ kind: "project-space", target: US_ACME });
	});

	it("asks for a pick where the inputs leave several", () => {
		for (const input of [
			{},
			{ domain: "acme" },
			{ server: "india" as const },
		]) {
			const choice = chooseDownloadTarget(REACHED, {
				format: "ccz",
				...input,
			});
			expect(choice).toEqual({
				kind: "refused",
				reason: "pick-project-space",
				message: PICK,
				reached: REACHED,
				heldFromHq: [],
			});
			if (choice.kind === "refused")
				expect(downloadRefusalLines(choice)).toEqual(EVERY_SPACE);
		}
	});

	it("refuses a project space the app is not published to, listing the ones it is", () => {
		for (const [input, named] of [
			[{ domain: "nowhere", server: "india" }, '"nowhere" on India'],
			[{ domain: "field-ops", server: "eu" }, '"field-ops" on EU'],
			[{ domain: "nowhere" }, '"nowhere"'],
			[{ server: "eu" }, "a project space on EU"],
		] as const) {
			const choice = chooseDownloadTarget(REACHED, {
				format: "ccz",
				...input,
			});
			expect(choice).toEqual({
				kind: "refused",
				reason: "unknown-project-space",
				message: unknown(named),
				reached: REACHED,
				heldFromHq: [],
			});
			if (choice.kind === "refused")
				expect(downloadRefusalLines(choice)).toEqual(EVERY_SPACE);
		}
	});
});

describe("chooseDownloadTarget for the import file", () => {
	it("refuses a project space, listing nothing", () => {
		for (const reached of [[], REACHED]) {
			const choice = chooseDownloadTarget(reached, {
				format: "json",
				domain: "acme",
			});
			expect(choice).toMatchObject({
				kind: "refused",
				reason: "domain-not-for-import-file",
				message: NOT_FOR_IMPORT_FILE,
				heldFromHq: [],
			});
			if (choice.kind === "refused")
				expect(downloadRefusalLines(choice)).toEqual([]);
		}
	});

	it("scopes its links to the one deployment the server leaves, and else to none", () => {
		expect(chooseDownloadTarget([], { format: "json" })).toEqual({
			kind: "none",
		});
		expect(chooseDownloadTarget([US_ACME], { format: "json" })).toEqual({
			kind: "project-space",
			target: US_ACME,
		});
		expect(chooseDownloadTarget(REACHED, { format: "json" })).toEqual({
			kind: "none",
		});
		expect(
			chooseDownloadTarget(REACHED, { format: "json", server: "production" }),
		).toEqual({ kind: "project-space", target: US_ACME });
		expect(
			chooseDownloadTarget(REACHED, { format: "json", server: "india" }),
		).toEqual({ kind: "none" });
		expect(
			chooseDownloadTarget(REACHED, { format: "json", server: "eu" }),
		).toEqual({ kind: "none" });
	});

	it("is never refused for want of a deployment or for a held selection", () => {
		expect(
			chooseDownloadTarget([], { format: "json", heldFromHq: ["a line"] }),
		).toEqual({ kind: "none" });
	});
});
