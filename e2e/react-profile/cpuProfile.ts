import type { CDPSession, Page } from "@playwright/test";

interface CpuProfileNode {
	readonly id: number;
	readonly callFrame: {
		readonly functionName: string;
		readonly url: string;
		readonly lineNumber: number;
		readonly columnNumber: number;
	};
}

interface CpuProfile {
	readonly nodes: readonly CpuProfileNode[];
	readonly samples?: readonly number[];
	readonly timeDeltas?: readonly number[];
}

export interface CpuSelfTime {
	readonly frame: string;
	readonly selfMs: number;
}

/** Start a sampling profile around one reproducible browser interaction. */
export async function startCpuProfile(page: Page): Promise<CDPSession> {
	const session = await page.context().newCDPSession(page);
	await session.send("Profiler.enable");
	await session.send("Profiler.start");
	return session;
}

/** Collapse a CDP sample profile into the frames that owned the main thread. */
export async function stopCpuProfile(
	session: CDPSession,
): Promise<readonly CpuSelfTime[]> {
	const { profile } = (await session.send("Profiler.stop")) as {
		profile: CpuProfile;
	};
	await session.send("Profiler.disable");
	const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
	const selfMilliseconds = new Map<string, number>();
	for (const [index, nodeId] of (profile.samples ?? []).entries()) {
		const node = nodes.get(nodeId);
		if (!node?.callFrame.url) continue;
		let source = node.callFrame.url;
		try {
			source = new URL(source).pathname;
		} catch {
			// Non-URL development module identifiers are already useful verbatim.
		}
		const frame = `${source}:${node.callFrame.lineNumber + 1}:${node.callFrame.columnNumber + 1} :: ${node.callFrame.functionName || "(anonymous)"}`;
		selfMilliseconds.set(
			frame,
			(selfMilliseconds.get(frame) ?? 0) +
				(profile.timeDeltas?.[index] ?? 0) / 1000,
		);
	}
	return [...selfMilliseconds]
		.map(([frame, selfMs]) => ({ frame, selfMs }))
		.sort((left, right) => right.selfMs - left.selfMs)
		.slice(0, 30);
}
