# Telemetry proposal

Status: planned; no telemetry is collected by this proposal.

Use PostHog for opt-in CLI usage statistics and categorized envkit failures. Add sanitized stack traces only after the filtering has been tested. Usage analytics and error reporting have separate consent settings.

## Consent

- Ask once on first interactive `init` or `login`, rather than during package installation: “Share basic usage statistics to help improve envkit? [y/N]”. Explain the fields collected and link to the policy.
- On the first unexpected envkit error, offer to enable sanitized error reporting if that choice is still undecided. A decline is final until the user changes the setting.
- Never prompt in CI, non-interactive sessions, or while a child command owns the terminal. Defer an unanswered choice until an appropriate interactive invocation.
- Wrong passwords, missing commands and other expected failures do not trigger the crash-reporting prompt.
- Send nothing before consent. Persist separate undecided/enabled/disabled choices locally outside the repository; do not put them in `.envkit.json`.
- Provide `envkit telemetry status`, `enable` and `disable`, with controls for usage and error reporting independently. Honor `DO_NOT_TRACK=1` and an envkit-specific disabling override. Define override precedence before implementation; disabling always wins.

## Allowed data

Use an explicit schema and allowlist, rather than capturing arbitrary objects and attempting to redact them afterward.

| Usage statistics                            | Error reports                             |
| ------------------------------------------- | ----------------------------------------- |
| Known envkit command name                   | Stable, predefined failure category       |
| CLI version, OS, architecture, Node version | CLI version and platform                  |
| Success/failure and duration                | Known envkit operation                    |
| Native or `bw` backend                      | Later: sanitized envkit-only stack frames |

Use a random installation ID, independent of vault accounts and project identities. Describe this as pseudonymous data, because the ID links events across invocations. Document rotation/deletion behavior and data retention before launch.

Never collect arguments, environment variables, variable names or values, command output, server URLs, emails, project identifiers, filesystem paths or raw error messages. Do not hash sensitive identifiers as a substitute for excluding them.

For `envkit run`, record only envkit's own operation. Do not collect the child command, its output, or exceptions from the user's application. Distinguish child exit failures from envkit bugs.

## Delivery and failure behavior

- PostHog's Node SDK supports custom events, exception reporting and shutdown flushing: https://posthog.com/docs/libraries/node.
- Avoid automatic exception capture initially. Exceptions and stacks can contain secrets and local paths; do not pass raw errors to the SDK.
- Preserve the roughly 110 ms warm-command performance target. Choose and measure a strict delivery budget; do not add an unbounded network wait to shutdown.
- Offline use and telemetry transport failures must be silent and must not change stdout, command exit codes or signal behavior.
- Hard crashes may prevent delivery. Reporting is best effort; never promise that every crash will be recorded.
- Initialize telemetry only when consent and runtime overrides permit it. Do not enable unrelated SDK features such as remote configuration or automatic instrumentation.

## Implementation checklist

- [ ] Define consent storage, override names, CLI controls and a versioned event schema.
- [ ] Select the PostHog project/region, retention and operational ownership; publish the exact collection policy.
- [ ] Implement opt-in usage events and categorized failures without raw exception payloads.
- [ ] Test default-off behavior, persisted declines, separate consent, CI, non-TTY, overrides and child-process isolation.
- [ ] Test event payloads against fixtures containing secrets, paths, URLs and malicious error text.
- [ ] Verify network timeouts, offline behavior, shutdown latency and unchanged command exit codes.
- [ ] Add sanitized stack traces only after dedicated filtering and regression tests.
