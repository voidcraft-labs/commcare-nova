import { mkdirSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import type {
	FullConfig,
	Reporter,
	Suite,
	TestCase,
	TestResult,
} from "@playwright/test/reporter";

/** Diagnostic timing data cannot add, remove or suppress a discovered test. */
export default class SmokeTimings implements Reporter {
	private rootDir = "";
	private durationsMs: Record<string, number> = {};

	onBegin(config: FullConfig): void {
		this.rootDir = config.rootDir;
	}

	onTestEnd(test: TestCase, result: TestResult): void {
		if (result.retry !== 0 || result.status !== "passed") return;
		const project = test.parent.project()?.name;
		if (project === undefined) throw new Error("Test has no owning project");
		const titles = [test.title];
		let parent: Suite | undefined = test.parent;
		while (parent?.type === "describe") {
			titles.unshift(parent.title);
			parent = parent.parent;
		}
		const file = relative(this.rootDir, test.location.file).replaceAll(
			"\\",
			"/",
		);
		const selector = `[${project}] › ${[file, ...titles].join(" › ")}`;
		this.durationsMs[selector] = Math.max(1, result.duration);
	}

	onEnd(): void {
		// Config lists this after the HTML reporter, which prepares this folder.
		mkdirSync("e2e/playwright-report", { recursive: true });
		writeFileSync(
			"e2e/playwright-report/timings.json",
			`${JSON.stringify({ runId: process.env.GITHUB_RUN_ID ?? null, durationsMs: this.durationsMs }, null, 2)}\n`,
		);
	}
}
