import type { RuntimeTarget } from "../../../lib/commcare/runtimeTarget";

/**
 * The deployment a native producer compiles its archive for when the Java
 * test reading the archive reads its structure and not where it sends its
 * requests. A producer whose Java test reads its URLs names a target of its
 * own.
 */
export const NATIVE_RUNTIME_TARGET: RuntimeTarget = {
	server: "production",
	domain: "nova-native-evidence",
	appId: "nova-native-evidence",
};
