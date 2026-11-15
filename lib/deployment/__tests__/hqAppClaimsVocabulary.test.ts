/**
 * `lib/db/hqAppClaims.ts` writes the deployment vocabulary without importing
 * it, because no file of `lib/db` imports `lib/deployment`. These are the
 * three places the two sides of that boundary must say the same thing: a
 * reason or an ownership added on one side and not the other fails here.
 */
import { describe, expect, it } from "vitest";
import {
	HQ_APP_END_REASONS,
	HQ_APP_MAPPING_OWNERSHIPS,
	NO_PHASE_OUTCOMES_JSON,
} from "@/lib/db/hqAppClaims";
import {
	DEPLOYMENT_END_REASONS,
	DEPLOYMENT_RESOURCE_OWNERSHIPS,
	NO_DEPLOYMENT_PHASE_OUTCOMES,
} from "../types";

describe("the claim module's vocabulary", () => {
	it("names the ownerships a mapping may hold", () => {
		expect(HQ_APP_MAPPING_OWNERSHIPS).toEqual(DEPLOYMENT_RESOURCE_OWNERSHIPS);
	});

	it("names the reasons a deployment ends for", () => {
		expect(HQ_APP_END_REASONS).toEqual(DEPLOYMENT_END_REASONS);
	});

	it("writes every phase as never run, as a deployment reads them", () => {
		expect(JSON.parse(NO_PHASE_OUTCOMES_JSON)).toEqual(
			NO_DEPLOYMENT_PHASE_OUTCOMES,
		);
	});
});
