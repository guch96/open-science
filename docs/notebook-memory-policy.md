# Notebook memory sampling and policy

Issue: https://github.com/guch96/open-science/issues/24. Design: Notebook lifecycle phase 1 R9,
chapters 06–08. This module owns runtime sampling and pressure state. It does not dispatch code,
terminate processes, change Notebook documents, or change `.science` packages.

`MemoryPolicyService` provides asynchronous `getState()` and synchronous `currentState()`.
Execution consumers must check `currentState()` immediately before their synchronous dispatch
commit after all asynchronous gates. The default freshness bound is two seconds; reclamation may
request up to ten seconds. Both monotonic and wall-clock elapsed time bound cached decisions so
suspend or clock rollback cannot leave old execution authority valid. Sampling waits at most five
seconds, coalesces callers within an execution domain, and does not overlap a timed-out underlying
read. Errors back off for at least thirty seconds. Cancellation ends that caller's wait without
cancelling other callers. Invalidation/disposal ends policy waits and discards late results.
Sample age starts before adapter sampling begins, so time spent collecting facts also consumes the
freshness budget. Each caller receives its own freshness decision when a shared read completes;
subscriber notifications use the execution freshness bound. Notification failures cannot change
sampled facts or prevent later subscribers from receiving the decision, and diagnostics report only
the first such failure per policy owner.

Periodic sampling is off until the lifecycle owner calls `setActive(true)`. It runs every ten
seconds when healthy, every five seconds while pressure is latched, and respects failure backoff.
The lifecycle owner must deactivate it when there are no resources or visible observations and
call `invalidate()` for known execution-domain/limit changes and suspend/resume notifications.
Sampling does not enable resource-diagnostic recording. Observations and subscriptions are internal;
no public execution/status enum or persisted data format is extended.

Platform facts:

- Windows uses one system-only `GetPerformanceInfo` call with physical available/total and
  committed/commit-limit counters. The new `totalPhysicalBytes` field is optional in the native
  TypeScript contract for old component compatibility; the policy requires it at runtime and gives
  an update/repair reason when missing. The Windows host sampler refuses WSL and other execution
  domains whose memory facts it cannot verify.
- macOS queries the current `kern.memorystatus_vm_pressure_level` and subscribes to native Dispatch
  pressure notifications. An event sequence synchronously invalidates old decisions even before a
  JS callback runs. A separate pressure-event sequence preserves WARN/CRITICAL through coalesced
  notifications. The first valid NORMAL may pass; after pressure, valid NORMAL observations must
  cover the configured recovery window. Unknown intervals reset recovery. This sysctl is a kernel
  implementation interface and requires certification for each supported distribution range.
- Linux authenticates procfs, pins the reader's initial cgroup namespace on nsfs, and checks its
  identity again after sampling. The initial inode is Linux `PROC_CGROUP_INIT_INO` (`0xEFFFFFFB`).
  The reader namespace matters because `/proc/<pid>/cgroup` paths are relative to the reader.
  Default complete visibility also requires a mount exposing true hierarchy root `/`. Namespace or
  mount-hidden ancestors fail closed. The internal deployment-certification seam is not exposed in
  the user threshold file and has no default private-container certification.
- Linux reads `MemAvailable`, checks commit only for strict overcommit mode 2, resolves actual
  cgroup mounts, validates kernel filesystem types, and pairs each ancestor limit with that
  ancestor's own usage. True cgroup v2 root has no `memory.*` limits; controller-inapplicable nodes
  are skipped while applicable ancestors remain checked. Membership, mounts, limits, applicability,
  and explicit target PID birth are rechecked, with one bounded retry for observed changes. Cgroup
  v1 requires hierarchical memory accounting and derives the exact unlimited sentinel from the
  kernel page size in authenticated `/proc/self/auxv`, including 16/64 KiB ARM64 kernels.

Local cgroup pressure observations carry `pressureScope: execution-domain` and the limiting
`constraintPath`. A reclaimer must prove candidate membership in that group or its
descendants. Host pressure uses `pressureScope: host`. Unknown sampling never supplies pressure
reclamation authority. History, imports/exports, cancellation, status, and identity-confirmed manual
release must remain outside the execution admission gate.

Pressure idle reclamation (issue #26) extends the existing `NotebookIdleReclamation` resource
collection and serial owner release path. Ordinary fifteen-minute expiry and per-kind idle capacity
of three run first and retain their existing limits. A pressure pass considers only continuously
unprotected resources idle for at least five minutes, attempts at most eight trees across all kinds,
and samples again after each result. Recovery, an unavailable sample, or stale authority stops the
pressure pass. Each completed pass has a minimum five-second cooldown; sampler initialization errors
back off for thirty seconds without renewing ordinary idle deadlines. Sample notifications cannot
turn rejected execution into a retry or an execution queue.

The runtime generation shares its admission policy with this reclaimer and activates periodic
sampling while live owner resources exist. Existing active-work, startup, queue, background,
observation, runtime-binding, identity, and cleanup fences remain authoritative. The existing archive
reservation is an additional synchronous hold checked through the owner's final commit; a hold does
not renew idle time. Reclamation uses the existing lifecycle teardown gates, process-tree owner,
epoch retirement, Windows receipts and terminated-state projection. Failed cleanup is reported and
keeps the original owner's cleanup responsibility. Logs describe candidate reasons and outcomes;
they contain no source, variables, credentials or command lines.

Current pressure reclamation is deliberately limited to owner-confirmed native host execution under
host pressure. A WSL Shell has no host-execution proof, and local cgroup pressure has no certified
candidate-membership proof in the current owner view; those resources are skipped by the pressure
branch. Ordinary idle rules and identity-confirmed manual release retain their separate contracts.
Remote dependency relaxation is also deferred unless an existing owner supplies the required proof.
These conservative boundaries are not full WSL/container release certification: issue #31 must
resolve the declared deployment support and supply real platform evidence before publication.

Execution admission (issue #25) is a main-process capability owned by each
`NotebookRuntimeService` generation. Direct service construction lazily creates the real platform
policy; production research reproduction shares the same service capability. The optional test seam
requires an explicit policy. Admission callbacks and observations are temporary and are never saved
to Notebook history or portable packages.

Every execution checks at submission and after asynchronous queues, approvals, environment and
sandbox preparation. The interpreter creation and final synchronous stdin writes carry the trusted
capability and compose cancellation, epoch and runtime-binding checks. Pressure or unavailable
sampling uses the existing failed result with `execution: not-started`, `kernelDispatched: false`
and `executionStarted: false`. It does not create a retry queue, erase an existing namespace or
rewrite already dispatched outcomes. Batch reproduction stops later targets after a memory refusal
while retaining completed targets.

An explicit user terminal submission freezes the actual live interpreter object before admission
awaits and rechecks it through dispatch. It cannot start a replacement interpreter. Legacy user
requests without `inputKind` retain their cell execution contract. Restart preflights memory before
modifying the old namespace or editing state. Runtime probes, history, repair and teardown keep their
existing gates without acquiring execution admission.

Linux source references: [namespace inode](https://github.com/torvalds/linux/blob/v6.12/include/linux/proc_ns.h),
[reader-relative cgroup paths](https://github.com/torvalds/linux/blob/v6.12/kernel/cgroup/cgroup.c#L6377),
[filesystem magic](https://github.com/torvalds/linux/blob/v6.12/include/uapi/linux/magic.h), and
[cgroup v2 controller and root semantics](https://docs.kernel.org/admin-guide/cgroup-v2.html).

Policy-only validation recorded on 2026-11-12: macOS 26.5 arm64, Node 24.22.2. These scoped results
precede final phase-1 integration and are not release acceptance. The source native package built with
`node node_modules/node-gyp/bin/node-gyp.js rebuild --directory packages/process-tree-native`.
All native CJS tests passed where applicable (6 passed, 12 Windows-only skipped). The focused
memory policy/config/native and resource-recorder Vitest suites passed (58 passed, 1 Linux-only
skipped). Scoped TypeScript validation and ESLint passed. Tests only read current facts; they do
not generate system pressure or compare the user's current resource profile to an incident.

Remaining release evidence belongs to issue #31: real Windows physical/commit behavior, real Linux
host/cgroup v1/v2 and initial/private namespace behavior, other architectures, macOS minimum versions
and signed/sandboxed distributions, and exact desktop/standalone/container packages. The native
source fingerprint changed; all five matching signed/published catalog records and fresh-download
verification remain required by `docs/native-components.md` before a release merge. No artifact was
published and the catalog/signature gate was not weakened.

## Candidate operator guidance

These notes describe the unreleased phase-1 candidate. Final verification and real platform,
Provider, native-artifact, and CI-owner acceptance remain open under #31.

Pressure or unavailable sampling ends the current execution request. Dismissing the notice, memory
recovery, idle reclamation, or manual release never retries it. An explicit terminal retry reads the
editor's current contents and rechecks the same live interpreter. After that interpreter is released,
the terminal stays inactive/read-only with history visible; use the trusted Agent or recovery entry
to establish a new interpreter. Agent continuation requires an explicit human action and a new
visible guidance message. Ordinary chat, automated continuation, or another tool-call identifier
cannot reopen the refused intent. Reads and explanation remain available.

Open Compute for the current project and use **Stop and release Notebook** in **Notebook resources**.
Switch projects to manage another project's Notebooks. The action applies to the confirmed session's
local resources, including all listed languages, environments, lanes, and active, idle, starting, and
unstarted work. It remains available when memory is healthy or sampling is unavailable. Confirmation
loses variables, connections, and unsaved in-memory objects; history, outputs, files, and environment installations
remain. It does not reverse file writes or other external effects. Independent remote Jobs and
their monitors retain their own lifecycle.

The backend must recheck the original resource set and current caller before stopping. Added or
replaced resources require refresh and confirmation; export, update, and migration conflicts must
not become hidden stop queues. Cleanup results remain per original owner/tree. Whole-tree exit and
required termination projection are both needed for success; partial failure keeps the original
cleanup responsibility. **View cleanup progress** shows these outcomes; closing it does not cancel
committed cleanup. **Retry cleanup** retries the retained failed resources using their original
handles and does not include replacements or new resources. Release alone never grants execution or
replays old code. **Continue Notebook work** remains available for a blocked session even after its
notice is dismissed and it has no remaining local resources.

Resource memory figures are diagnostic estimates with a capture time, metric kind, and coverage.
Missing measurements mean unknown rather than zero, and partial coverage must remain visible. RSS
can count shared pages more than once and does not promise the bytes release will reclaim. Only
original owner and process-birth/epoch identity authorize cleanup; metrics do not supply ownership.

## Threshold configuration

The optional file is `<Config Root>/notebook-memory-policy.json`, outside Notebook documents and
`.science` packages. Default roots are `~/.open-science` for production and `~/.open-science-project`
for development. Existing `OPEN_SCIENCE_CONFIG_ROOT` and CLI `--config-root` profile selection apply;
see [standalone profiles](standalone-runtime.md). There is no settings UI or hot reload. The runtime
loads the policy lazily once per generation; stop and restart orderly to apply edits.

```json
{
  "windowsEnterRatio": 0.1,
  "windowsExitRatio": 0.2,
  "linuxEnterRatio": 0.1,
  "linuxExitRatio": 0.2,
  "macNormalRecoveryMs": 20000
}
```

These are the defaults. Ratio fields accept finite numbers from `0.01` through `0.9`, inclusive;
each platform's exit ratio must be strictly greater than its enter ratio. Windows/Linux enter
pressure when any applicable required remaining-memory ratio is at or below the enter ratio.
Recovery requires all applicable ratios to exceed the exit ratio. Cgroup `memory.high` has its
separate fixed rule: enter at its limit and recover only with more than 20% remaining. macOS recovery
accepts integer milliseconds from `5000` through `300000`; after WARN/CRITICAL, trustworthy NORMAL
observations must cover that interval.

Missing fields use defaults; unknown optional fields are ignored. Malformed JSON, an unreadable file,
or any invalid recognized value falls back to the complete default set, with one configuration
diagnostic per policy load. Thresholds cannot disable sampling, required commit/cgroup/domain facts,
identity or freshness checks, or the final dispatch check. They cannot force execution while sampling
is unavailable. Defaults still require certification for the actual platform and distribution.

## Stored-data compatibility and export

`run.json` remains version 1 and portable `.science` manifests remain schema 1. Historical documents,
coarse termination records, and supported older archives retain their existing readers. Imports are
cold: source-machine processes and live bindings are not recreated. A fork receives a fresh runtime
identity, and subsequent execution uses current admission. Windows Job receipts remain local and
outside portable packages. Samples, latches, nonces, execution grants, blocked intents, confirmation
revisions, and temporary leases are transient; restarting the application cannot replay refused code
or restore an old execution grant.

Skill files, Specialist packages, Connector definitions, credential storage, and OAuth formats do not
change. Unavailable memory sampling cannot block historical reads, import/export, cancellation, or
identity-confirmed manual cleanup. This preserves the existing [directional compatibility
contract](compatibility.md#historical-data-and-upgrade-direction), not arbitrary binary downgrades or
mixed-version desktop/backend operation.

Package export and fork install the existing archive admission fence, wait for already committed
Notebook teardown, and only then reserve persistence for the snapshot. Conversation export shares
this ordering. Unsafe cleanup or failed termination projection prevents export. Teardown never waits
for export. Package-export cancellation ends its own wait and source fence without cancelling earlier
cleanup; existing checksums and final source-revision checks remain required.

## Release acceptance and rollback

Issue [#31](https://github.com/guch96/open-science/issues/31) owns release acceptance. Record the exact
source/tree, system, architecture, Node version, distribution, commands, results, skips, and limits for
each run. Local source tests and controlled fixtures cannot certify other systems or signed packages.

| Scope                                             | Available evidence and remaining acceptance                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS 26.5 arm64, Node 24.22.2 source build       | Local native sampling and scoped owner/RPC checks; no machine-wide pressure was generated. This does not certify macOS 12, Intel, or a signed desktop distribution.                  |
| macOS 12+ arm64/x64 and Windows x64 distributions | Real pressure transitions, full-tree cleanup, failures, signing, and upgrade acceptance remain required. Simulated-platform tests do not replace them.                               |
| Linux arm64/x64 host and cgroup v1/v2             | Adapter fixtures do not certify actual hierarchy visibility, pressure transitions, or cleanup on the declared distributions.                                                         |
| Certified containers and WSL                      | Require trustworthy facts from the actual execution domain. The earlier private-container Node 20 refusal probe is negative-path evidence only, not Node 24/container certification. |
| Standalone npm/CLI                                | Verify the exact supported runtime and packaged native components, not only source execution.                                                                                        |
| External Providers                                | Controlled ACP/RPC refresh fixtures do not prove that actual supported Providers consume new MCP configuration while preserving history, namespace, and independent work.            |

Every declared environment needs evidence or an explicit reviewed support decision. An environment
without trustworthy required sampling stops publication; support must not narrow silently and there
is no force-run bypass.

The changed native fingerprint requires all five matching artifacts, macOS/Windows signatures,
immutable publication, catalog update, and fresh actual downloads under the [native-component
workflow](native-components.md#update-the-binaries). During verification on 2026-11-12, the repository
permission API returned `enabled: true` and workflow state was `active`, but `native-components.yml`
dispatch with `dry_run=true` still failed with HTTP 422, `Actions has been disabled for this repository.`
No run was created and no
signing, publication, or catalog update occurred. Keep the PR draft and #31 open until these gates
and the real acceptance above are resolved; do not weaken fingerprint or signature checks.

The protected native runtime-consumer declarations in `scripts/ci/module-runtime-consumers.json` and
Windows exact-path routing in `scripts/ci/change-impact.json` also require independent CI-owner
approval under the [CI control-plane rules](ci.md#ci-control-plane-approval). Local registration checks
and agent review do not supply that approval.

For rollback:

1. Use existing shutdown/update handoff to stop new admission. Preserve the selected profile/data
   backup and record matching application/backend versions.
2. Drain all original Notebook owners, including failed trees and installer/Attempt/batch work.
   Require whole-tree exit and required sandbox/termination projection; uncertainty retains cleanup
   responsibility.
3. Only after the old runtime has stopped, open the selected previous matching binary and profile
   backup. Never run two versions against the same live tree or treat binary downgrade as data
   rollback.
4. Preserve history, files, and local receipts under their existing contracts. Released variables and
   connections do not return; never replay rejected or historical code automatically.

Disabling the policy or changing declared support requires a release decision. Threshold
configuration is not a rollback or force-run switch.
