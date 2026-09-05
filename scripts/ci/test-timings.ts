import { mkdirSync, writeFileSync } from "node:fs";
import type { Reporter, TestModule } from "vitest/node";

/** Keep import/setup costs visible: test-body timing alone hides expensive fixtures. */
export default class TestTimings implements Reporter {
	private rows: Record<string, string | number>[] = [];

	onTestModuleEnd(module: TestModule): void {
		const d = module.diagnostic();
		this.rows.push({
			file: module.relativeModuleId,
			testsMs: d.duration,
			importMs: d.collectDuration,
			setupMs: d.setupDuration,
			environmentMs: d.environmentSetupDuration,
			totalMs:
				d.duration +
				d.collectDuration +
				d.setupDuration +
				d.environmentSetupDuration,
		});
	}

	onTestRunEnd(): void {
		this.rows.sort((a, b) => Number(b.totalMs) - Number(a.totalMs));
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/timings.json",
			`${JSON.stringify(this.rows, null, 2)}\n`,
		);
		console.table(this.rows.slice(0, 15));
	}
}
