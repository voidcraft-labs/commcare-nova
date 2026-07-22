/**
 * Narrow test seam for proving that each app-stream durable reader—not merely
 * the generic pump—recovers from a failed SELECT or migration reauthorization.
 * Production installs no hooks.
 */

interface StreamReadTestHooks {
	readonly beforeMutationRead?: () => void;
	readonly beforeLookupManifestRead?: () => void;
	readonly beforeMigrationReauthorization?: () => void;
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

export function runBeforeMigrationReauthorizationTestHook(): void {
	hooks?.beforeMigrationReauthorization?.();
}

export function runAfterAppStreamSubscribeTestHook(): void {
	hooks?.afterAppStreamSubscribe?.();
}
