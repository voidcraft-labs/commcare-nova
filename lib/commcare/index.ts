// lib/commcare/index.ts
//
// The one-way bridge from our normalized domain to CommCare's wire
// formats. THIS PACKAGE IS THE ONLY PLACE in lib/ that imports
// CommCare-specific vocabulary (question, case_property_on, etc.).
//
// Sub-packages own their own surface and are imported directly
// (e.g. `@/lib/commcare/xpath`) — this barrel intentionally exports
// nothing so that adding a new sub-package does not grow a single
// monolithic surface.

export {};
