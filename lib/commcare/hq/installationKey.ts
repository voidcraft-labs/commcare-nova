/** HQ prints the key directly after ?profile= in profile.xml and suite resources.
 * Compare the parameter the worker sends and Django reads with the stored key. */
export function nativeInstallationKey(key: string): boolean {
	if (!key) return false;
	const link = new URL(`https://hq.invalid/suite.xml?profile=${key}`);
	return !link.hash && link.searchParams.get("profile") === key;
}
