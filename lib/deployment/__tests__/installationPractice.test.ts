import type { MockAgent } from "undici";
import { expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { testUuid } from "@/__tests__/helpers/uuid";
import { checkPracticePreparation } from "../installationPractice";
import type { InstallationProfileCheckpoint } from "../installationProfileReview";

const creds = {
	server: "eu",
	username: "account",
	apiKey: "fixture-key",
} as const;
const host = "https://eu.commcarehq.org";
const profiles = [
	{
		id: "clinic",
		name: "Clinic team",
		langs: ["en"],
		practiceWorkerId: "worker-clinic",
	},
	{
		id: "visits",
		name: "Visits team",
		langs: ["en"],
		practiceWorkerId: "worker-visits",
	},
];
const proposed = profiles.map((p) => ({
	uuid: testUuid(p.id),
	key: p.id,
	practiceWorkerId: p.practiceWorkerId,
}));
type Start = InstallationProfileCheckpoint["practiceStart"];
type FileState = "cold" | "incomplete" | "ready";
function step(
	peer: MockAgent,
	version: number,
	states: [FileState, FileState],
	start?: Start,
) {
	const buildId = `build-${version}`;
	const reply = (path: string, body: unknown) =>
		peer
			.get(host)
			.intercept({
				path,
				method: "GET",
				headers: { authorization: "ApiKey account:fixture-key" },
			})
			.reply(200, JSON.stringify(body));
	reply("/a/clinic/api/application/v1/app/", {
		id: "app",
		name: "Practice",
		version,
		built_from_app_id: null,
		modules: [],
		versions: [{ id: buildId, version, is_released: false }],
	});
	const external_blobs: Record<string, { content_length: number }> = {
		"files/profile.ccpr": { content_length: 80 },
		"files/suite.xml": { content_length: 90 },
	};
	for (const [i, p] of profiles.entries()) {
		if (states[i] === "cold") continue;
		for (const file of [
			"profile.ccpr",
			"suite.xml",
			"default/app_strings.txt",
			"en/app_strings.txt",
			...(states[i] === "ready" ? ["practice_user_restore.xml"] : []),
		])
			external_blobs[`files/${p.id}/${file}`] = { content_length: 42 };
	}
	const build_profiles = Object.fromEntries(
		profiles.map((p) => [
			p.id,
			{
				name: p.name,
				langs: p.langs,
				practice_mobile_worker_id: p.practiceWorkerId,
			},
		]),
	);
	reply(`/a/clinic/api/application/v1/${buildId}/?extras=true`, {
		id: buildId,
		_id: buildId,
		domain: "clinic",
		doc_type: "Application",
		copy_of: "app",
		built_from_app_id: "app",
		version,
		is_released: false,
		build_profiles,
		external_blobs,
	});
	return checkPracticePreparation({
		creds,
		appId: "app",
		domain: "clinic",
		profiles,
		proposed,
		held: [],
		workingVersion: version,
		start,
	});
}

it.each(["same version", "new version"] as const)(
	"remembers the first worker when another installation is prepared on the %s",
	async (mode) => {
		await withHttpPeer(async (peer) => {
			const initial = await step(peer, 4, [
				"cold",
				mode === "same version" ? "cold" : "incomplete",
			]);
			if (initial.kind !== "review" || !initial.start)
				throw new Error("Expected a preparation baseline");
			const one = await step(
				peer,
				4,
				["ready", mode === "same version" ? "cold" : "incomplete"],
				initial.start,
			);
			if (one.kind !== "review" || !one.start)
				throw new Error("Expected the other worker to need preparation");
			expect(one.message).toContain("Visits team");
			expect(one.message).not.toContain("Clinic team");
			expect(one.message).toContain(
				mode === "same version" ? "CommCare_v4.ccz" : "make a new version",
			);
			expect(one.start.witnessed).toMatchObject([
				{ key: "clinic", practiceWitness: { version: 4, buildId: "build-4" } },
			]);
			let baseline = one.start;
			const finalVersion = mode === "same version" ? 4 : 5;
			if (mode === "new version") {
				const next = await step(peer, 5, ["cold", "cold"], baseline);
				if (next.kind !== "review" || !next.start)
					throw new Error("Expected one outstanding worker");
				expect(next.message).toContain("CommCare_v5.ccz");
				expect(next.message).not.toContain("Clinic team");
				baseline = next.start;
			}
			const ready = await step(
				peer,
				finalVersion,
				[mode === "same version" ? "ready" : "cold", "ready"],
				baseline,
			);
			expect(ready).toMatchObject({
				kind: "agreed",
				bindings: [
					{
						key: "clinic",
						practiceWitness: { version: 4, buildId: "build-4" },
					},
					{
						key: "visits",
						practiceWitness: {
							version: finalVersion,
							buildId: `build-${finalVersion}`,
						},
					},
				],
			});
		});
	},
);

it("keeps a partial transition first seen on a newer build after earlier installation files were already present", async () => {
	await withHttpPeer(async (peer) => {
		const old = await step(peer, 7, ["ready", "ready"]);
		if (old.kind !== "review" || !old.start)
			throw new Error("Previously prepared workers need a new build");
		expect(old.message).toContain("make a new version");
		const partial = await step(peer, 8, ["ready", "cold"], old.start);
		if (partial.kind !== "review" || !partial.start)
			throw new Error("Expected the other worker to need a download");
		expect(partial.message).toContain("CommCare_v8.ccz");
		expect(partial.message).not.toContain("Clinic team");
		const complete = await step(peer, 8, ["ready", "ready"], partial.start);
		expect(complete).toMatchObject({
			kind: "agreed",
			bindings: [
				{ key: "clinic", practiceWitness: { version: 8 } },
				{ key: "visits", practiceWitness: { version: 8 } },
			],
		});
	});
});
