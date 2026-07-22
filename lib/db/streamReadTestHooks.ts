/**
 * Narrow test seam for proving that each app-stream durable reader—not merely
 * the generic pump—recovers from a failed SELECT. Production installs no hooks.
 */

interface StreamReadTestHooks {
	readonly beforeMutationRead?: () => void;
	readonly beforeLookupManifestRead?: () => void;
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
