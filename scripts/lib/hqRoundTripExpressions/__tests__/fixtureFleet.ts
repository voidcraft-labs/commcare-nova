/**
 * The frozen pre-step fixtures as a fleet the plan reads, in memory: each
 * fixture's raw carriers as one app, the stored `case_type_schemas` rows
 * pull request 2's head derived from it (`fixtures/base-census.json`), and
 * the deployments and private work a test gives it. No database: the pure
 * tests of the plan, its report and its census build the same plan the
 * scan builds, from the same transform.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { availableLookupContext } from "@/lib/__tests__/lookupFixtures";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import { ALL_ICON_SLUGS } from "@/lib/domain/builtinIcons";
import { builtinAssetRows } from "@/lib/media/builtinIconAssets";
import type { EmissionFragment } from "../emissionNormal";
import { type RawCarriers, readRawDocument } from "../oldShape";
import {
	assemblePlannedFleet,
	type FleetSource,
	fleetSeqDigestOf,
	type PlannedFleet,
	type SourceApp,
	type SourceDeployment,
	transformFleet,
} from "../plan";
import { transformApp } from "../transform";

const FIXTURES = join(import.meta.dirname, "fixtures");
export const FIXTURE_PROJECT = "project-pre-step-fixtures";

interface BaseFixture {
	readonly fixture: string;
	readonly caseTypeSchemas: Readonly<Record<string, string>>;
	readonly files: readonly EmissionFragment[];
}

/** The frozen base census of every fixture, by fixture id. */
export const BASE_FIXTURES: ReadonlyMap<string, BaseFixture> = new Map(
	(
		JSON.parse(readFileSync(join(FIXTURES, "base-census.json"), "utf8")) as {
			fixtures: BaseFixture[];
		}
	).fixtures.map((entry) => [entry.fixture, entry]),
);

export interface FixtureManifestEntry {
	readonly id: string;
	readonly kind: "corpus" | "synthetic";
	readonly blockers: readonly string[];
	readonly reasons: readonly string[];
	readonly faults?: readonly unknown[];
	readonly context?: Readonly<Record<string, unknown>>;
}

export const FIXTURE_MANIFEST: readonly FixtureManifestEntry[] = (
	JSON.parse(
		readFileSync(join(FIXTURES, "pre-step", "manifest.json"), "utf8"),
	) as { fixtures: FixtureManifestEntry[] }
).fixtures;

export function fixtureCarriers(id: string): RawCarriers {
	return JSON.parse(
		readFileSync(join(FIXTURES, "pre-step", id, "carriers.json"), "utf8"),
	) as RawCarriers;
}

/** What a test gives one fixture app beside its carriers. */
export interface FixtureAppOptions {
	/** The app's id; the fixture's id where absent. */
	readonly appId?: string;
	readonly deployments?: readonly SourceDeployment[];
	readonly discardsPrivateWork?: boolean;
}

/** One fixture as a stored app: its id is its fixture id, its sequence 1. */
export function fixtureApp(
	id: string,
	options: FixtureAppOptions = {},
): SourceApp {
	const carriers = fixtureCarriers(id);
	const base = BASE_FIXTURES.get(id);
	const appId = options.appId ?? id;
	return {
		appId,
		projectId: FIXTURE_PROJECT,
		baseSeq: 1,
		deleted: false,
		carriers,
		raw: readRawDocument(appId, carriers),
		discardsPrivateWork: options.discardsPrivateWork ?? false,
		storedCaseSchemas: new Map(Object.entries(base?.caseTypeSchemas ?? {})),
		storedCaseKeys: new Map(),
		deployments: options.deployments ?? [],
	};
}

/** A fleet of the given fixture apps in one Project with no lookup tables or media. */
export function fixtureFleetSource(apps: readonly SourceApp[]): FleetSource {
	const sorted = [...apps].sort((a, b) =>
		a.appId < b.appId ? -1 : a.appId > b.appId ? 1 : 0,
	);
	return {
		apps: sorted,
		projects: new Map([
			[
				FIXTURE_PROJECT,
				{
					projectId: FIXTURE_PROJECT,
					lookupContext: availableLookupContext(
						[],
						FIXTURE_PROJECT,
					) as LookupValidationContext & { kind: "available" },
					mediaAssets: new Map(
						builtinAssetRows(ALL_ICON_SLUGS).map((record) => [
							record.id as string,
							record,
						]),
					),
				},
			],
		]),
		privateWork: {
			openWorkspaces: 0,
			openChangeSets: 0,
			activeCandidates: 0,
			endingSessions: [],
		},
		holders: {
			liveApps: [],
			liveSessions: [],
			settleableApps: [],
			settleableSessions: [],
			unsettledApps: [],
			unsettledSessions: [],
		},
		appsInFleet: sorted.length,
		deletedApps: 0,
		fleetSeqDigest: fleetSeqDigestOf(
			sorted.map((app) => ({ id: app.appId, seq: app.baseSeq })),
		),
		databaseBytes: 0,
	};
}

/** The plan over a fixture fleet, with no stored case values to meet. */
export function planFixtureFleet(apps: readonly SourceApp[]): PlannedFleet {
	const source = fixtureFleetSource(apps);
	return assemblePlannedFleet(
		source,
		transformFleet(source, transformApp),
		new Map(),
	);
}
