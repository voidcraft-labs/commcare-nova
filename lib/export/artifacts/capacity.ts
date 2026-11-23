import { ApiError } from "@/lib/apiError";

/** Per-process ceilings include the two fixed-size buffers a preparing request
 * inspects before admitting an archive, plus range responses in flight. */
const active = { prepare: 0, range: 0, workerChoices: 0 };
const limits = { prepare: 2, range: 8, workerChoices: 1 };
export function claimExportWorkspace(kind: keyof typeof active): () => void {
	if (active[kind] >= limits[kind])
		throw new ApiError(
			"Nova is preparing other downloads. You can try again shortly.",
			429,
		);
	active[kind]++;
	return () => {
		active[kind]--;
	};
}
