/** Diagnostic retries retain a fresh fixture; CI still fails on flaky results. */
export const SMOKE_RETRIES = process.env.CI ? 2 : 0;
