import { describe, expect, it } from "vitest";
import { BuilderPhase } from "@/lib/session/builderTypes";
import { GenerationStage } from "@/lib/session/types";
import {
	computeScaffoldProgress,
	deriveGenerationSignalMode,
} from "./scaffoldProgress";

describe("deriveGenerationSignalMode", () => {
	it("uses scaffolding for an initial build foundation", () => {
		expect(deriveGenerationSignalMode(true, GenerationStage.Foundation)).toBe(
			"scaffolding",
		);
	});

	it("uses building once an initial build starts content construction", () => {
		expect(deriveGenerationSignalMode(true, GenerationStage.Build)).toBe(
			"building",
		);
	});

	it.each([
		GenerationStage.Foundation,
		GenerationStage.Build,
	])("does not let %s tags take over the signal grid during an edit", (stage) => {
		expect(deriveGenerationSignalMode(false, stage)).toBeNull();
	});
});

describe("computeScaffoldProgress", () => {
	it("shows no scaffold progress outside a build", () => {
		expect(computeScaffoldProgress(BuilderPhase.Idle, null, false)).toBe(0);
		expect(computeScaffoldProgress(BuilderPhase.Loading, null, false)).toBe(0);
	});

	it("treats ready and completed apps as fully built", () => {
		expect(computeScaffoldProgress(BuilderPhase.Ready, null, false)).toBe(1);
		expect(computeScaffoldProgress(BuilderPhase.Completed, null, false)).toBe(
			1,
		);
	});

	it("ramps through foundation work as the optional data model lands", () => {
		expect(
			computeScaffoldProgress(
				BuilderPhase.Generating,
				GenerationStage.Foundation,
				false,
			),
		).toBe(0.05);
		expect(
			computeScaffoldProgress(
				BuilderPhase.Generating,
				GenerationStage.Foundation,
				true,
			),
		).toBe(0.3);
	});

	it("hands the visual off once content construction starts", () => {
		expect(
			computeScaffoldProgress(
				BuilderPhase.Generating,
				GenerationStage.Build,
				false,
			),
		).toBe(1);
	});
});
