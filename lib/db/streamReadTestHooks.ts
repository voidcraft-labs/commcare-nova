/**
 * Narrow test seam for proving that each app-stream durable reader—not merely
 * the generic pump—recovers from a failed SELECT or app-change reauthorization.
 * Production installs no hooks.
 */

interface StreamReadTestHooks {
	readonly beforeMutationRead?: () => void;
	readonly beforeLookupManifestRead?: () => void;
	readonly beforeAppChangeReauthorization?: () => void;
	readonly afterAppStreamSubscribe?: () => void;
}

let hooks: StreamReadTestHooks | null = null;

export function __setStreamReadTestHooksForTests(
	next: StreamReadTestHooks | null,
): void {
	hooks = next;
}

export function runBeforeMutationReadTestHook(): void {
	hooks?.beforeMutationRead?.();
}

export function runBeforeLookupManifestReadTestHook(): void {
	hooks?.beforeLookupManifestRead?.();
}

export function runBeforeAppChangeReauthorizationTestHook(): void {
	hooks?.beforeAppChangeReauthorization?.();
}

export function runAfterAppStreamSubscribeTestHook(): void {
	hooks?.afterAppStreamSubscribe?.();
}
