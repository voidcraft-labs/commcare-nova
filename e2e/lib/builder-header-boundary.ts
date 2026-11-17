/**
 * The Server Actions the builder header's other controls reach, for a peer
 * that mounts the production `BuilderHeader` to test its publishing
 * controls. None of these controls is used by those journeys: the notice
 * chip renders nothing with no notices, and Preview's identity menu stands in
 * the band's centre cell, which such a peer does not give the header. A call
 * that arrives anyway fails the journey rather than reaching a database.
 */
function unexpected(name: string): never {
	throw new Error(`${name} isn't part of the header journeys`);
}

export async function dismissAppNoticeAction(): Promise<never> {
	return unexpected("dismissAppNoticeAction");
}
export async function listAppTestsAction(): Promise<never> {
	return unexpected("listAppTestsAction");
}
export async function readAppTestAction(): Promise<never> {
	return unexpected("readAppTestAction");
}
export async function countClaimedCasesAction(): Promise<never> {
	return unexpected("countClaimedCasesAction");
}
export async function releaseClaimedCasesAction(): Promise<never> {
	return unexpected("releaseClaimedCasesAction");
}
