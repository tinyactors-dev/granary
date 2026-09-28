# Architecture decision records

One decision per file (ADR 0001). Numbers are allocated in ranges per
workstream, so gaps are expected. History is kept: an ADR whose decision
changed is marked in its status line (`Superseded by N` or `Partially
superseded by N`) and the newer ADR says what changed.

## Current state

- **Naming and configuration:** ADR 0230 lists every environment variable and
  the naming scheme; it overrides the names in earlier ADRs.
- **GitHub:** granary connects only as a GitHub App (0160, 0190–0194, 0230); it gates issues and pull requests (0280, 0281).
- **Databases:** one baseline migration each for granary.sqlite and
  ops.sqlite (0230).
- **UI structure:** six-item main nav (Overview, Activity, Policy, Ops, Settings, Admin), one glossary (item, delivery, decision, action) and one banner per page (0291); `/admin` for admins in every environment, each area gated by a capability (0290).
- **Production:** granary.tinyactors.dev (VM ta-granary), telemetry to the shared ta-metrics stack (0231); deploy with `mise run deploy`, runbook in `docs/manual/operations-runbook.md` (0233).

| ADR | Title | State |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | active |
| [0002](0002-actor-topology.md) | Actor and I/O processor topology | active |
| [0003](0003-sqlite-write-ahead-log.md) | Application-level write-ahead log in SQLite | partly superseded |
| [0004](0004-policy-decisions.md) | Policy: who may open issues | partly superseded (0260: blocklist first; wording → 0250) |
| [0005](0005-processes-ports-and-configuration.md) | Processes, ports and configuration | partly superseded |
| [0006](0006-fake-github-contract.md) | Fake GitHub contract | partly superseded |
| [0007](0007-testing-through-traces.md) | Tests run against a running system and assert on traces | active |
| [0008](0008-sveltekit-on-bun-with-vite.md) | SvelteKit on Bun (Vite is the one exception to "no Vite") | active |
| [0009](0009-dev-route-and-debugger.md) | The /__dev route and the debugger | partly superseded |
| [0020](0020-package-and-tooling-layout.md) | Package and tooling layout | active |
| [0021](0021-shadcn-svelte-setup.md) | shadcn-svelte setup | active |
| [0022](0022-native-addon-under-vite-and-adapter-bun.md) | Loading the @tinyactors/node native addon under Vite and adapter-bun | active |
| [0023](0023-experimental-remote-functions-and-async-svelte.md) | Enabling remote functions and async Svelte | active |
| [0024](0024-agent-browser-for-interactive-verification.md) | agent-browser for interactive verification | active |
| [0025](0025-production-secrets-in-fnox-prod-profile.md) | Production secrets live in the fnox `prod` profile | active |
| [0026](0026-pitchfork-for-long-lived-processes.md) | Long-lived processes run under pitchfork; never kill by pattern | partly superseded |
| [0027](0027-real-local-ops-stack.md) | A "real" local stack for the ops targets (RustFS + Grafana LGTM) | active |
| [0030](0030-typebox-schemas-and-standard-schema-adapter.md) | TypeBox schemas and the Standard Schema adapter | active |
| [0031](0031-remote-function-catalogue-and-authorization.md) | Remote function catalogue and authorization rules | active |
| [0032](0032-backend-interface-seam.md) | The `Backend` interface is the seam between UI and actor system | active |
| [0033](0033-actor-event-protocol.md) | Event and message protocol between actors, processors and the WAL | active |
| [0034](0034-oauth-and-session-routes.md) | OAuth and session route contract | partly superseded |
| [0035](0035-fake-github-control-schemas.md) | Fake GitHub control API schemas | active |
| [0036](0036-configuration-loading-and-dev-mode.md) | Configuration loading and dev-mode computation | partly superseded |
| [0040](0040-runtime-boot-and-lifecycle.md) | Runtime boot, issue actor states and process lifecycle | partly superseded |
| [0041](0041-outbox-relay-behaviour.md) | Outbox relay behaviour and its observable effects | partly superseded |
| [0042](0042-trace-vocabulary.md) | Observable trace vocabulary | partly superseded |
| [0050](0050-ui-shell-navigation-and-auth-gating.md) | UI shell, navigation and auth gating | partly superseded |
| [0051](0051-data-loading-with-remote-functions.md) | Data loading with remote functions | active |
| [0052](0052-ui-components-and-visual-conventions.md) | UI components and visual conventions | active |
| [0053](0053-dev-console-design.md) | Developer console (`/__dev`) design | partly superseded |
| [0054](0054-jaeger-style-trace-explorer.md) | Jaeger-style trace explorer in /__dev | active |
| [0056](0056-actor-inspector.md) | Actor inspector: snapshots of an actor's inside | active |
| [0057](0057-json-view-component.md) | A standalone JsonView component | active |
| [0058](0058-json-view-everywhere.md) | JSON view everywhere, through JsonBlock | active |
| [0060](0060-fake-github-architecture.md) | Fake GitHub architecture: actors, I/O processors, faults | partly superseded |
| [0061](0061-integration-test-harness.md) | Integration test harness | partly superseded |
| [0062](0062-trace-vocabulary-and-predicates.md) | Trace vocabulary and test predicates | partly superseded |
| [0063](0063-integration-test-scenarios.md) | Integration test scenarios | active |
| [0070](0070-loadgen-process-placement.md) | The load generator is a separate process with its own actor system | active |
| [0071](0071-personas-as-statecharts.md) | Personas are statecharts | active |
| [0072](0072-scenarios-and-populations.md) | Scenarios are seeded populations with an arrival process | active |
| [0073](0073-observation-metrics-and-invariants.md) | Observation, metrics and invariants | active |
| [0074](0074-fuzzing-and-chaos.md) | Fuzzing and chaos personas | active |
| [0075](0075-fake-github-event-stream-comments-raw.md) | Fake GitHub: event stream, user comments, raw deliveries | active |
| [0076](0076-dev-portal-subsection.md) | The dev portal is a subsection with its own navigation | partly superseded |
| [0077](0077-ui-component-previews.md) | Storybook-style component previews under /__dev/ui | active |
| [0080](0080-ops-domain-module-boundary.md) | Operations is a separate domain module with a pinned contract | active |
| [0081](0081-ops-process-and-system-placement.md) | Ops runs in the app process, in its own tinyactors System | partly superseded |
| [0082](0082-ops-actor-and-io-topology.md) | Ops actor and I/O processor topology | partly superseded |
| [0083](0083-backup-method-vacuum-into-in-a-worker.md) | Backups use `VACUUM INTO` in a Worker (no online backup API in bun:sqlite) | partly superseded |
| [0084](0084-object-storage-destinations.md) | Object storage destinations via Bun.S3Client, committed by manifest | partly superseded |
| [0085](0085-telemetry-sinks-otlp-first.md) | Telemetry export: OTLP/HTTP first, native Loki push as a log sink | partly superseded |
| [0086](0086-ops-secret-store.md) | Secret store: envelope encryption in ops.sqlite, master key from fnox | partly superseded |
| [0087](0087-in-product-configuration-and-seed-env.md) | Ops configuration is in-product; env vars only seed | superseded |
| [0088](0088-watchdog-signals-and-alerting.md) | The watchdog: what "sleep at night" means, and who wakes you | superseded |
| [0089](0089-ops-durable-state.md) | Ops keeps its own durable state in ops.sqlite | partly superseded |
| [0090](0090-fake-infra.md) | fake-infra: stand-ins for object storage, Loki, OTLP and notifications | partly superseded |
| [0091](0091-ops-test-strategy.md) | Ops tests: running systems, fakes, traces, restore drills | partly superseded |
| [0092](0092-ops-ui-and-backend-seam.md) | Ops admin UI and its OpsBackend seam | partly superseded |
| [0093](0093-telemetry-feedback-loops-and-redaction.md) | No telemetry feedback loops; redaction before export | active |
| [0094](0094-ops-implementation-plan.md) | Ops implementation plan and parallelisation | superseded |
| [0095](0095-r2-backup-destination.md) | Cloudflare R2 is the backup destination (S3-generic underneath) | partly superseded |
| [0096](0096-bounded-retention.md) | Retention is bounded: hard caps, convergent pruning, no archive tier | active |
| [0097](0097-backup-encryption-mandatory.md) | Backup encryption is mandatory | active |
| [0098](0098-production-on-exe-dev-resources-and-staging.md) | Production on an exe.dev VM: resource facts, thresholds, backup staging | partly superseded |
| [0099](0099-telemetry-to-self-hosted-grafana-on-exe-dev.md) | Telemetry to self-hosted Grafana on an exe.dev VM | partly superseded |
| [0100](0100-no-paging-problems-wait-until-morning.md) | No paging: the system self-heals; problems wait until morning | active |
| [0101](0101-ops-topology-revision-self-healing.md) | Ops topology revision: self-healing, no notifier/heartbeat | active |
| [0102](0102-ops-configuration-and-seeds-revision.md) | Ops configuration and seeds, revised for R2 and exe.dev | partly superseded |
| [0103](0103-ops-tests-and-fake-infra-revision.md) | Ops tests and fake-infra, revised | active |
| [0104](0104-ops-ui-revision.md) | Ops UI revision: banner, projections, no notifications | active |
| [0105](0105-ops-implementation-plan-revision.md) | Ops implementation plan, revised | active |
| [0106](0106-eu-region-and-r2-jurisdiction.md) | EU region: exe.dev FRA for both VMs, R2 bucket in the EU jurisdiction | active |
| [0107](0107-egress-accounting.md) | Egress accounting: only R2 uploads count; telemetry budget is a volume cap | active |
| [0108](0108-confirmed-defaults-and-contract-tests.md) | Confirmed defaults and agreed contract tests | active |
| [0109](0109-m0-scope-clarifications.md) | M0 scope clarifications | partly superseded |
| [0110](0110-m0-composition-seam-and-ownership.md) | M0 composition seam, shared DB opener, and M1–M4 ownership | active |
| [0111](0111-backups-feature-internals-and-ledger.md) | Backups feature internals: pure charts, a ledger processor, one runtime | active |
| [0112](0112-object-store-behaviour.md) | Object store behaviour: trust nothing, verify everything | active |
| [0113](0113-backup-artifact-format.md) | Backup artifact format and the snapshot Worker | active |
| [0114](0114-retention-implementation.md) | Retention implementation details | active |
| [0115](0115-backups-remediations.md) | Remediations contributed by the backups feature | active |
| [0116](0116-restore-cli.md) | `mise run ops:restore`: restore with only 1Password and bucket credentials | active |
| [0117](0117-secret-store-implementation.md) | Secret store implementation details | active |
| [0118](0118-backups-seeds-and-backend-semantics.md) | Backups seeds and OpsBackend semantics | partly superseded |
| [0120](0120-ops-assembly-and-system.md) | Ops assembly: features, the ops System, failure isolation | active |
| [0121](0121-telemetry-fan-out-on-the-wire.md) | Telemetry fan-out works on the OTLP wire format | active |
| [0122](0122-sink-seeds-and-test-gating.md) | Telemetry sink seeds, the legacy endpoint, and test gating | partly superseded |
| [0123](0123-conditions-are-sample-driven.md) | Conditions are sample-driven; remediations are contributed by features | active |
| [0124](0124-granary-host-health-provider.md) | granary's host health provider | active |
| [0125](0125-boundary-rule-regex.md) | Boundary rules match ops module paths only | active |
| [0130](0130-fake-infra-process-and-actors.md) | fake-infra: process, System and actors | active |
| [0131](0131-fake-s3-surface-with-r2-semantics.md) | The fake S3 surface and its R2 semantics | active |
| [0132](0132-r2-fidelity-toggles.md) | R2 fidelity toggles | active |
| [0133](0133-fake-credentials.md) | Fake credentials | active |
| [0134](0134-fake-infra-faults.md) | Faults in fake-infra | active |
| [0135](0135-fake-otlp-receiver.md) | The fake OTLP receiver | active |
| [0136](0136-fake-infra-observation.md) | Observing fake-infra: request log, counters, SSE | active |
| [0137](0137-exe-dev-proxy-stand-in.md) | The exe.dev proxy stand-in | active |
| [0138](0138-fake-infra-dev-seeds-and-daemon.md) | fake-infra dev seeds, mise task and pitchfork daemon | active |
| [0139](0139-dev-portal-fake-infra.md) | /__dev/infra and the dev Backend seam for fake-infra | active |
| [0140](0140-ops-ui-structure-and-remote-functions.md) | /ops UI: structure, remote functions and stub wiring | active |
| [0141](0141-ops-ui-write-only-secrets-in-forms.md) | Write-only secrets in /ops forms | active |
| [0142](0142-ops-ui-calm-tone-and-banner.md) | Calm tone and the "while you were away" banner | active |
| [0150](0150-ops-dev-seeds-against-fake-infra.md) | Dev seeds point the operations module at fake-infra | partly superseded |
| [0151](0151-dev-json-api-over-the-ops-backend.md) | A dev-only JSON API over the OpsBackend | active |
| [0152](0152-ops-integration-fixes.md) | Integration fixes between the ops features | active |
| [0153](0153-ops-scenario-tests.md) | Ops scenario tests against fake-infra | active |
| [0154](0154-tool-links-from-configuration.md) | Links to external tools come from configuration | active |
| [0155](0155-family-in-span-names.md) | Actor family in span names; tinyactors name and kind as attributes | active |
| [0156](0156-packaging-and-distribution.md) | Ship granary as a public npm package run by Bun | active |
| [0157](0157-data-directory-and-configuration-sources.md) | Data directory, configuration sources and the master key | partly superseded |
| [0158](0158-platform-secret-store.md) | The encrypted secret store becomes a platform service | active |
| [0159](0159-cli-and-admin-socket.md) | The `granary` CLI and the local admin socket | active |
| [0160](0160-github-app-connection.md) | The GitHub connection is a GitHub App created in-product | partly superseded |
| [0161](0161-admins-login-links-and-first-run.md) | In-product admins, login links, and the first-run wizard | partly superseded |
| [0162](0162-missed-webhook-catch-up.md) | Missed-webhook catch-up via the app's delivery log | active |
| [0163](0163-health-endpoints-and-process-management.md) | Health endpoints, systemd, reverse proxies | active |
| [0164](0164-fake-github-app-parity.md) | Fake GitHub parity for GitHub Apps | active |
| [0165](0165-operator-manual.md) | The operator manual | active |
| [0166](0166-deployment-build-plan.md) | Deployment readiness: milestones and parallel fork split | active |
| [0170](0170-login-link-lifecycle.md) | Login links: confirm page, revocation, ids without tokens | active |
| [0171](0171-platform-secret-store-implementation.md) | Platform secret store: one envelope core, two adapters | active |
| [0172](0172-data-dir-and-boot-configuration.md) | Data dir resolution and what boot still requires | partly superseded |
| [0173](0173-admin-socket-implementation.md) | Admin socket: limits and failure behaviour | active |
| [0174](0174-cli-build-and-serve.md) | CLI build, `serve` in-process, `.env` handling | active |
| [0175](0175-first-run-redirect-and-probes.md) | First-run redirect and probe handling in hooks | active |
| [0176](0176-config-keys-routing.md) | `granary config`: where keys live | active |
| [0177](0177-committing-from-parallel-forks.md) | Committing from parallel forks without a shared-index race | active |
| [0180](0180-release-pack-from-clean-git-export.md) | release:pack builds from a clean git export with a generated manifest | partly superseded |
| [0181](0181-release-verify-on-clean-linux-containers.md) | release:verify installs the tarball on clean Linux containers | partly superseded |
| [0182](0182-release-publish-guardrails.md) | release:publish never publishes implicitly | active |
| [0183](0183-provenance-later-via-ci.md) | Publish from the laptop without provenance for now; CI + provenance later | superseded |
| [0184](0184-amd64-verification-on-arm64-hosts.md) | x86-64 verification needs a native host; emulated runs are skipped | active |
| [0185](0185-release-channels-and-dev-versions.md) | Release channels: `dev` for frequent builds, `latest` for stable releases | active |
| [0186](0186-single-release-script-and-github-actions.md) | One release script, run from the laptop or a manual GitHub Action | active |
| [0187](0187-package-identity.md) | Package identity: MIT, `@tinyactors/granary`, repo `tinyactors-dev/granary` | active |
| [0188](0188-prereleases-never-latest.md) | A prerelease never becomes `latest`; `release:promote` moves `latest` | active |
| [0189](0189-release-build-outside-the-repository.md) | Build the release outside the repository | active |
| [0190](0190-github-connection-storage.md) | GitHub connection storage: own tables and schema steps | partly superseded |
| [0191](0191-github-app-auth.md) | GitHub App auth: JWT via node:crypto, cached installation tokens, per-repo clients | active |
| [0192](0192-webhook-repo-policy-and-lifecycle.md) | Webhooks: secret by mode, per-repo policy, installation sync | active |
| [0193](0193-github-seeds-and-secret-fallback.md) | GitHub seeds, secret fallback and sign-in credentials | partly superseded |
| [0194](0194-delivery-catchup-implementation.md) | Delivery catch-up: implementation details | partly superseded |
| [0200](0200-fake-github-app-actor-and-routing.md) | Fake GitHub Apps: one `apps/main` actor, repo events routed to installed apps | active |
| [0201](0201-fake-github-app-crypto.md) | Real RSA keys and RS256 JWT checks in the fake | active |
| [0202](0202-fake-github-delivery-log-and-outage.md) | App delivery log, redelivery and the webhook outage switch | active |
| [0203](0203-app-cli-and-catchup-tests.md) | Tests for the GitHub App, catch-up and the CLI | partly superseded |
| [0210](0210-settings-section.md) | The /settings section | active |
| [0211](0211-github-app-manifest-form.md) | Creating the GitHub App from the browser; callback redirects | active |
| [0212](0212-settings-ui-contract-gaps.md) | Settings UI: what the contract does not cover (yet) | active |
| [0220](0220-one-source-for-github-mode-and-disconnect.md) | One source for `github.mode`; admins table at sign-in; disconnect | active |
| [0221](0221-catch-up-health-and-ignore-reasons.md) | Catch-up health in ops; stored ignore reasons | active |
| [0222](0222-manual-walkthrough-findings.md) | The manual is verified by walking through it | active |
| [0230](0230-one-naming-scheme-no-legacy-before-first-release.md) | One naming scheme, no legacy before the first release | active |
| [0231](0231-production-deployment-on-exe-dev.md) | Production deployment: ta-granary and the shared ta-metrics stack | active |
| [0232](0232-cli-never-writes-to-an-unexpected-data-dir.md) | The CLI never writes to an unexpected data dir | active |
| [0233](0233-deploy-task-and-operations-handbook.md) | `mise run deploy` and the operations handbook | active |
| [0234](0234-structured-logs-access-log-and-trace-correlation.md) | Structured logs, an HTTP access log, and log ↔ trace correlation | active |
| [0240](0240-setup-checklist-from-real-state.md) | The setup checklist is computed on the server from the real state | active |
| [0250](0250-closing-message-templates.md) | Closing messages are in-product Markdown templates | active |
| [0251](0251-render-the-closing-message-at-enqueue-time.md) | Render the closing message when the close effect is queued | active |
| [0252](0252-template-escaping-and-safe-markdown-preview.md) | Escaping template values and a safe Markdown preview | active |
| [0260](0260-blocklist-precedence-and-expiry.md) | A blocklist that beats the allowlist and maintainer associations | active |
| [0270](0270-brand-wheat-logo-and-favicons.md) | Brand: colored wheat logo, favicons and app icons from one source | active |
| [0271](0271-github-app-logo.md) | A flat logo for GitHub, uploaded by hand | active |
| [0280](0280-gate-pull-requests-like-issues.md) | Gate pull requests like issues | active |
| [0281](0281-pull-request-permission-upgrade.md) | Pull request access for existing GitHub Apps | active |
| [0282](0282-fake-github-pull-requests-and-permissions.md) | Fake GitHub: pull requests and accepted permissions | active |
| [0283](0283-pull-request-tests.md) | Pull request scenarios | active |
| [0290](0290-admin-section-and-capabilities.md) | An admin section in every environment, gated by capability | active |
| [0291](0291-structure-activity-policy-and-glossary.md) | Structure: Activity, Policy, one glossary, one header, one banner | active |
