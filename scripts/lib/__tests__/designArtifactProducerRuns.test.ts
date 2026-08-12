import { describe, expect, it } from "vitest";
import {
	collectDesignArtifactProducerRunIds,
	designArtifactDiagnosticRuns,
} from "../designArtifactProducerRuns";

describe("collectDesignArtifactProducerRunIds", () => {
	it("includes superseded revisions and reviews of an accepted revision's parent", () => {
		expect(
			collectDesignArtifactProducerRunIds(
				[
					{ createdByRunId: "superseded-draft-run" },
					{ createdByRunId: "reviewed-parent-run" },
					{ createdByRunId: "accepted-revision-run" },
				],
				[
					{ createdByRunId: "parent-review-run" },
					{ createdByRunId: "superseded-review-run" },
					{ createdByRunId: "parent-review-run" },
				],
				[
					{ createdByRunId: "recovered-workspace-step-run" },
					{ createdByRunId: "accepted-revision-run" },
				],
			),
		).toEqual([
			"superseded-draft-run",
			"reviewed-parent-run",
			"accepted-revision-run",
			"parent-review-run",
			"superseded-review-run",
			"recovered-workspace-step-run",
		]);
	});
});

describe("designArtifactDiagnosticRuns", () => {
	it("retains artifact producers when the process died before summary flush", () => {
		expect(
			designArtifactDiagnosticRuns(
				["workspace-run", "summarized-run"],
				["summarized-run", "summary-only-run"],
			),
		).toEqual({
			runIds: ["workspace-run", "summarized-run", "summary-only-run"],
			missingSummaryCount: 1,
		});
	});
});
