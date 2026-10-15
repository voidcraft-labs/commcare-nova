import type { RuntimeTarget } from "../runtimeTarget";

/**
 * The deployment a test compiles an archive for when what it reads is the
 * archive's structure and not where the archive sends its requests.
 */
export const TEST_RUNTIME_TARGET: RuntimeTarget = {
	server: "production",
	domain: "nova-test",
	appId: "nova-test-app",
};
