# Reviewed dependency evidence

## Accepted artifact

Nova reviewed and accepts only this input to its local hardening transformer:

- npm package: `agent-react-devtools@0.4.0`
- source commit: `f22798bcb0510d312cc6f86762135a0e82d2819b`
- annotated tag object: `a82e24ba2cb70041397e37ad5fa25c0060fd3b50`
- npm integrity: `sha512-nq5VgJH/lRJOGd1kCQW3+hjzNLfv4vYrhZtpC5k554MthTGJnZ9PqVZf6tx5N++YVJsWUsyuDG/S2nOfUlHi0Q==`
- React peer selected and tested: `react-devtools-core@6.1.5`

The npm artifact's `gitHead` and SLSA provenance matched the source commit. A
clean source build reproduced the published JavaScript byte for byte, and the
published source maps matched the tagged TypeScript. npm signature verification
reported no missing or invalid signatures at review time. The tag itself was
not cryptographically signed, so the npm integrity, provenance, exact source
hashes, and checked-in transformer are the operative trust chain.

## Static and runtime findings

The reviewed source contained no telemetry, outbound HTTP client, dynamic code
evaluation, or shell execution. Its unmodified defaults were still unsuitable
for Nova:

- the WebSocket daemon listened on every interface without authentication,
  Origin checks, a connection limit, or a payload cap;
- malformed React operations could enter unchecked loops;
- its Next App Router initializer ran too late for Nova's Next 16, React 19,
  and Turbopack stack, while a static import added roughly 187 KB raw / 51 KB
  gzip to a production client chunk even when runtime-disabled;
- daemon state used ordinary user-readable filesystem modes;
- component inspection could return unbounded props, state, hooks, and strings;
- the package conflated global component ids across multiple connected apps;
- its profile diff grouped by display name and omitted render-count regressions;
- the broad `react-devtools-core >=5` peer range resolved to newer unreviewed
  implementations.

Nova therefore does not accept the upstream package or its generic skill
unchanged. `scripts/harden-agent-react-devtools.mjs` fails closed unless every
audited input file has its exact SHA-256, then installs the authenticated
loopback, payload, permissions, and bounded-output changes and verifies the
exact hardened output hashes. The repository's pre-hydration injection is
development-only and the harness admits one page.

## Upgrade rule

Do not widen either version or update a transformer hash to make an install
pass. Clone the new tag into a private temporary directory, repeat the source,
artifact, provenance, dependency, static-code, runtime-network, bundle, and
profile-correctness review, then deliberately update the exact versions,
transformer fragments and hashes, this evidence, and the production-exclusion
tests together.
