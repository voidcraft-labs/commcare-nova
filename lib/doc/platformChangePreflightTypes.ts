/**
 * Client-safe shapes of the platform change preflight
 * (`platformChangePreflight.ts`): what the builder's platform section asks
 * and what it is told. Plain JSON both ways, so a Server Action can carry
 * them.
 */

import type { MediaRefLocation } from "@/lib/domain/mediaRefs";
import type { Platform } from "@/lib/domain/platforms";
import type { StructuredCommitFinding } from "./hooks/useBlueprintMutations";

export interface PlatformChangePreflightInput {
	readonly appId: string;
	/** The declaration asked for: one platform, or `null` for both. */
	readonly runsOnlyOn: Platform | null;
}

/** One gate finding the new declaration raises, with its builder line. */
export interface PlatformChangeFindingRow {
	/** `userFacingError(finding)`: the builder's line for it. */
	readonly line: string;
	readonly finding: StructuredCommitFinding;
}

/** One authored media reference a platform the new declaration adds can't play. */
export interface PlatformChangeMediaRow {
	/** `describeUnplayableReferences([reference])`, the kernel's own words. */
	readonly line: string;
	readonly location: MediaRefLocation;
}

export type PlatformChangePreflightResult =
	| { readonly kind: "ok"; readonly mutationSeq: number }
	| {
			readonly kind: "refused";
			readonly mutationSeq: number;
			readonly findings: readonly PlatformChangeFindingRow[];
			readonly media: readonly PlatformChangeMediaRow[];
	  }
	| { readonly kind: "not-found" | "unauthenticated" | "forbidden" };
