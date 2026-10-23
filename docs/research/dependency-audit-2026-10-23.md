# ip-address 10.7.4 audit

PR #799 upgrades the resolved `ip-address` from 10.7.3 to 10.7.4 without changing
its parents or Nova's direct dependency declarations.

The [upstream comparison](https://github.com/beaugunderson/ip-address/compare/v10.7.3...v10.7.4)
contains one runtime change: IPv6 zone extraction finds the first `%` by index
instead of retrying an unanchored regex. This removes quadratic work when
rejecting a long sequence of `%` characters followed by a line terminator,
while preserving accepted addresses and zones. The other changes maintain
upstream generated docs and commit checks.

`RE_ZONE_STRING` in `v6/constants` is newly deprecated and scheduled for removal
in 11.0.0. Nova has no direct imports of this package. Its resolved consumers
are `express-rate-limit` through the shadcn/profiler MCP SDK and `socks` through
shadcn's registry tooling. Neither imports that constant. Their constructors,
subnet operations and byte-array conversion remain supported; no Nova API
migration or new feature adoption applies to this patch.

A clean `npm ci` installs 10.7.4. Focused execution checks cover IPv6 zones,
rejection of a malformed 1 MiB input, the byte-array conversion used by socks,
and IPv4/IPv6 key generation through express-rate-limit.

The original CI failure was a 20-minute smoke-job timeout during Playwright OS
dependency installation; the smoke suite never started. The log still fetched
from Azure despite the existing URL replacement. GitHub's
[runner setup](https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/configure-apt-sources.sh)
now writes `mirror+file:/etc/apt/apt-mirrors.txt` into `ubuntu.sources`, with
Azure first in the list. The workflow now replaces both that indirection and
the older direct Azure URL with Ubuntu's HTTPS archive. Suites, dependency
versions, signature verification and the job timeout stay the same.
