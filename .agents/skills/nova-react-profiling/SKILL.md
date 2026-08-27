---
name: nova-react-profiling
description: Profile CommCare Nova's React Builder in component terms, automate reproducible UI interactions, diagnose re-renders, and compare performance changes. Use for Nova React runtime inspection or Builder performance optimization; do not use for server-only or raw JavaScript profiling.
---

# Nova React profiling

Read [the reviewed dependency evidence](references/dependency-audit.md) before
changing the pinned package, hardening patch, or integration boundary.

Use Nova's committed harness. It owns a private database, seeded session and
Builder app, hardened DevTools daemon, development server, headed Playwright
browser, profile export, parser run, and teardown:

```bash
npm run profile:react
```

No user action, OAuth, production data, GCP credential, or model call is needed.
Raw and parsed artifacts land in the gitignored `react-profiles/` directory.

## Safety and integration invariants

- Never run `agent-react-devtools init` or `uninit`. Its Next App Router wiring
  is too late for Nova's React/Turbopack stack and can include DevTools in a
  production bundle.
- Never start the daemon against its default state directory or port. Use
  `npm run profile:react`; it supplies a random port and token, exact Origin,
  private temporary state, one accepted browser connection, and cleanup.
- The package and peer are exact-pinned. `postinstall` hash-checks the audited
  upstream bytes before applying Nova's loopback/authentication/payload/privacy
  hardening. Do not bypass a patch hash failure or widen its accepted input.
- The bridge is injected before hydration only when
  `NODE_ENV=development` and `NOVA_REACT_PROFILE=1`. Production must contain no
  bridge or `react-devtools-core` chunk. Keep the app-owned
  `react-profile-client.ts` registry shim: Next's generated registry uses
  `require()`, while the package exposes its connector only for ESM imports.
- Prefer tree, count, and profiling commands. `get component` can expose props,
  state, hooks, and therefore authored data; use it only when that value-level
  inspection is necessary. The local patch redacts secret-shaped keys and
  truncates string output, but it cannot classify all sensitive application
  data.

## Creating the performance test

The default scenario at `e2e/react-profile/builder-smoke.spec.ts` proves the
whole connection and export path with a deterministic sidebar interaction. Add
or adapt a spec under `e2e/react-profile/` for the exact reported interaction.
Keep one page/app connected at a time and use the seeded manifest in
`e2e/.auth/seed.json`; do not call the SA or any real external service.

Run one scenario with Playwright arguments after `--`, for example:

```bash
npm run profile:react -- --grep "case search"
```

The default spec demonstrates how to issue CLI commands with
`NOVA_REACT_PROFILE_STATE_DIR`. Record only the target interaction between
`profile start` and `profile stop`, then export the raw version-5 React DevTools
JSON. Keep waits semantic so before/after runs perform the same committed React
work.

## Interpreting and comparing results

Use both views:

- `agent-react-devtools profile slow`, `rerenders`, `timeline`, `commit`, and
  `report` provide compact React component/cause summaries while the harness is
  active.
- `python3 scripts/analyze-react-profile.py <profile.json>` ranks cumulative
  self duration, frames, ancestor chains, and probable parent-cascade renders.

Treat absolute development-mode timings as directional. Establish repeated
baselines for the same scenario, optimize from React evidence, and repeat the
same runs after each material change. Confirm both render counts and durations;
the package's `profile diff` groups only by display name and can conflate
repeated Builder components, so inspect raw/parser evidence before claiming an
improvement.

After changing the profiler integration itself, also run its focused Vitest
tests, typecheck, a normal production build, and verify the normal build output
contains no `agent-react-devtools`, `react-devtools-core`, or profiler WebSocket
markers.
