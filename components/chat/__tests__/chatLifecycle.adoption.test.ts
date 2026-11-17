/**
 * The receipt boundary's second key set: a brought-in app's receipt is the
 * twelve keys of every birth and `adoption`, admitted exactly, while the three
 * existing births keep parsing their twelve keys as before.
 */
import { describe, expect, it } from "vitest";
import { COMMCARE_SERVER_IDS } from "@/lib/commcare/servers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { canonicalAppGenesis, emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import { parseAppMaterializationReceipt } from "../chatLifecycle";

const APP_ID = "4f1d5a0c-7c3e-4c2b-9a51-2d8e6b0f3a17";

function starterBirth() {
	const empty = emptyBlueprintDoc(APP_ID);
	const genesis = canonicalAppGenesis(empty);
	const verdict = mutationCommitVerdict(
		empty,
		genesis.mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok) throw new Error("The canonical starter must be valid.");
	return { genesis, blueprint: toPersistableDoc(verdict.nextDoc) };
}

const { genesis, blueprint } = starterBirth();

/** The twelve keys every birth sends, as the blank app's action sends them. */
const blankReceipt = {
	eventVersion: 1,
	designSessionId: null,
	appId: APP_ID,
	projectId: "project-1",
	role: "editor",
	canEdit: true,
	seq: 1,
	batchId: `genesis:${APP_ID}`,
	changeSetId: null,
	snapshotDigest: "ab".repeat(32),
	blueprint,
	starter: {
		moduleUuid: genesis.moduleUuid,
		formUuid: genesis.formUuid,
		fieldUuid: genesis.fieldUuid,
	},
} as const;

/** A reviewed build's receipt: design lineage and a change set, no starter. */
const designSliceReceipt = {
	...blankReceipt,
	designSessionId: "0b944e00-722d-48ab-8d4d-47e922970b5f",
	changeSetId: "change-set-1",
	starter: null,
};

/** An ordinary session's first save: a change set, no lineage, no starter. */
const sessionReceipt = {
	...blankReceipt,
	changeSetId: "change-set-2",
	starter: null,
};

const adoption = {
	server: "production",
	domain: "demo-space",
	remoteAppId: "0f3c9a1b2d4e5f60718293a4b5c6d7e8",
};

/** The thirteen keys only a bring-in's create sends. */
const adoptedReceipt = {
	...blankReceipt,
	starter: null,
	adoption,
};

describe("the adopted receipt", () => {
	it("parses with its adoption", () => {
		expect(parseAppMaterializationReceipt(adoptedReceipt)).toEqual(
			adoptedReceipt,
		);
	});

	it("parses from every CommCare HQ environment an app is brought in from", () => {
		for (const server of COMMCARE_SERVER_IDS) {
			expect(
				parseAppMaterializationReceipt({
					...adoptedReceipt,
					adoption: { ...adoption, server },
				})?.adoption,
			).toEqual({ ...adoption, server });
		}
	});

	it("parses at a later sequence, as a repeated create reads it back", () => {
		expect(
			parseAppMaterializationReceipt({ ...adoptedReceipt, seq: 3 }),
		).toMatchObject({ seq: 3, adoption });
	});

	it("is refused with design lineage, a change set or a starter", () => {
		expect(
			parseAppMaterializationReceipt({
				...adoptedReceipt,
				designSessionId: designSliceReceipt.designSessionId,
			}),
		).toBeNull();
		expect(
			parseAppMaterializationReceipt({
				...adoptedReceipt,
				changeSetId: "change-set-1",
			}),
		).toBeNull();
		expect(
			parseAppMaterializationReceipt({
				...adoptedReceipt,
				starter: blankReceipt.starter,
			}),
		).toBeNull();
	});

	it("is refused unless adoption is exactly three non-blank strings", () => {
		const refused: readonly unknown[] = [
			null,
			"production",
			[adoption.server, adoption.domain, adoption.remoteAppId],
			{ ...adoption, appId: APP_ID },
			{ server: adoption.server, domain: adoption.domain },
			{ ...adoption, domain: "  " },
			{ ...adoption, remoteAppId: "" },
			{ ...adoption, remoteAppId: 7 },
			Object.assign(Object.create({ inherited: true }), adoption),
		];
		for (const value of refused) {
			expect(
				parseAppMaterializationReceipt({ ...adoptedReceipt, adoption: value }),
			).toBeNull();
		}
	});

	it("is refused from a server Nova does not know", () => {
		for (const server of [
			"staging",
			"Production",
			"https://www.commcarehq.org",
		]) {
			expect(
				parseAppMaterializationReceipt({
					...adoptedReceipt,
					adoption: { ...adoption, server },
				}),
			).toBeNull();
		}
	});

	it("is refused with a fourteenth key", () => {
		expect(
			parseAppMaterializationReceipt({ ...adoptedReceipt, unexpected: true }),
		).toBeNull();
	});

	it("still holds every rule of the twelve keys", () => {
		expect(
			parseAppMaterializationReceipt({ ...adoptedReceipt, seq: 0 }),
		).toBeNull();
		expect(
			parseAppMaterializationReceipt({
				...adoptedReceipt,
				snapshotDigest: "not-a-digest",
			}),
		).toBeNull();
		expect(
			parseAppMaterializationReceipt({
				...adoptedReceipt,
				blueprint: { ...blueprint, appId: "another-app" },
			}),
		).toBeNull();
		expect(
			parseAppMaterializationReceipt({ ...adoptedReceipt, role: " " }),
		).toBeNull();
	});
});

describe("the receipts of the three existing births", () => {
	it("parse as before, with no adoption", () => {
		for (const receipt of [blankReceipt, designSliceReceipt, sessionReceipt]) {
			expect(parseAppMaterializationReceipt(receipt)).toEqual({
				...receipt,
				adoption: null,
			});
		}
	});

	it("are refused with an adoption of null as a thirteenth key", () => {
		for (const receipt of [blankReceipt, designSliceReceipt, sessionReceipt]) {
			expect(
				parseAppMaterializationReceipt({ ...receipt, adoption: null }),
			).toBeNull();
		}
	});
});
