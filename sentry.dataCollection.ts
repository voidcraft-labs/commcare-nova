import type * as Sentry from "@sentry/nextjs";

type DataCollection = NonNullable<
	NonNullable<Parameters<typeof Sentry.init>[0]>["dataCollection"]
>;

/* Header and query-parameter names that locate a person on the network. */
const networkIdentity = {
	deny: ["forwarded", "-ip", "remote-", "via", "-user"],
};

/**
 * What the server and edge SDKs may collect on their own.
 *
 * Left unset, the SDK attaches cookies, request and response bodies, bound
 * query parameters, queue arguments, and model inputs and outputs to events
 * and spans. On the server those carry the Better Auth session token, case
 * data, and the Solutions Architect's prompts, so each category is named and
 * turned off here. Headers and query parameters stay, minus the ones that
 * identify a client's address.
 *
 * `userInfo` covers only what the SDK infers (the request IP). The identity
 * `identifySentryUser` sets explicitly is always sent.
 */
export const serverDataCollection: DataCollection = {
	userInfo: false,
	cookies: false,
	httpHeaders: { request: networkIdentity, response: networkIdentity },
	httpBodies: [],
	urlQueryParams: networkIdentity,
	genAI: { inputs: false, outputs: false },
	databaseQueryData: false,
	queues: false,
	graphQL: { document: false, variables: false },
};
