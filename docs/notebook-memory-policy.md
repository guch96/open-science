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

Validation on 2026-11-12: macOS 26.5 arm64, Node 24.22.2. The source native package built with
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
