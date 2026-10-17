/**
 * The notice lines the writer stores, from each deployment's class and the
 * migrated document, with no probe of HQ.
 */

import { describe, expect, it } from "vitest";
import { assemblePersistedBlueprintJsonText } from "@/lib/db/persistedJson";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { entryPointInventory } from "@/lib/domain/entryPoints";
import { migrationNoticeEntrySchema } from "@/lib/notices/migrationNotice";
import { appNoticeEntries, deploymentNoticeReasons } from "../notice";
import type { AppPlan, DeploymentPlan } from "../plan";
import { readFixtureCarriers } from "./fixtures/preStep";

function documentOf(id: string) {
	const carriers = readFixtureCarriers(id);
	return hydratePersistedBlueprint(
		assemblePersistedBlueprintJsonText(id, carriers.root, carriers.rows),
	);
}

const withEntryPoints = documentOf("targeted-invalid-question-ids");
const withoutEntryPoints = documentOf("navigation-base");

function deployment(patch: Partial<DeploymentPlan> = {}): DeploymentPlan {
	return {
		deploymentId: "00000000-0000-7000-8000-00000000d001",
		server: "production",
		domain: "field-ops",
		remoteAppId: "remote-app-1",
		outcome: "unreadable",
		buildSpecVersion: null,
		pairing: null,
		identities: [],
		keyUses: [],
		notices: [],
		...patch,
	};
}

function app(patch: Partial<AppPlan> = {}): AppPlan {
	return {
		appId: "app-1",
		projectId: "project-1",
		baseSeq: 3,
		baseDigest: "a".repeat(64),
		targetDigest: "a".repeat(64),
		blockers: [],
		changes: [],
		discardsPrivateWork: false,
		deployments: [],
		...patch,
	};
}

describe("deployment notice reasons", () => {
	it("tells every deployment that has a next publish that new links wait for it", () => {
		expect(entryPointInventory(withEntryPoints).length).toBeGreaterThan(0);
		for (const outcome of [
			"read-in-full",
			"no-form-ids",
			"unreadable",
		] as const) {
			expect(deploymentNoticeReasons(outcome, withEntryPoints)).toEqual([
				"deep-links-need-republish",
			]);
		}
	});

	it("says nothing about a next publish a deployment does not have", () => {
		for (const outcome of ["deleted", "unsupported", "transient"] as const) {
			expect(deploymentNoticeReasons(outcome, withEntryPoints)).toEqual([]);
		}
	});

	it("says nothing about links in an app with no entry point", () => {
		expect(entryPointInventory(withoutEntryPoints)).toEqual([]);
		expect(deploymentNoticeReasons("read-in-full", withoutEntryPoints)).toEqual(
			[],
		);
	});
});

describe("an app's notice entries", () => {
	it("are empty for an app nothing changed in", () => {
		expect(appNoticeEntries(app(), "Clinic")).toEqual([]);
	});

	it("put each deployment's lines first, then the discarded private work, each a valid entry", () => {
		const entries = appNoticeEntries(
			app({
				discardsPrivateWork: true,
				deployments: [deployment({ notices: ["deep-links-need-republish"] })],
			}),
			"Clinic",
		);
		expect(entries).toEqual([
			{
				kind: "deployment",
				reason: "deep-links-need-republish",
				deployment: {
					deploymentId: "00000000-0000-7000-8000-00000000d001",
					server: "production",
					domain: "field-ops",
				},
			},
			{
				kind: "document",
				reason: "unsaved-assistant-work-discarded",
				entity: { type: "app", nameAtMigration: "Clinic" },
			},
		]);
		for (const entry of entries) {
			expect(migrationNoticeEntrySchema.safeParse(entry).success).toBe(true);
		}
	});

	it("cuts a stored name at the length an entry keeps", () => {
		const [entry] = appNoticeEntries(
			app({ discardsPrivateWork: true }),
			"x".repeat(250),
		);
		expect(entry?.kind === "document" && entry.entity.nameAtMigration).toBe(
			"x".repeat(200),
		);
	});
});
