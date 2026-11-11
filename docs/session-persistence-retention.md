# Session retention and diagnostics

The JSON Session authority remains unchanged. Main's opportunistic hydration cache stores one
**complete catalog scan**, not a general collection of individually cached Sessions. Ordinary
historical Session opening reads the requested authority from disk.

## Retention boundary

The complete scan is retained only when it contains at most **32 Sessions** and its estimated
retained JavaScript values occupy at most **32 MiB**. A successful reuse refreshes a **30-second
idle expiry**. Mutation invalidation and idle expiry release the entire cached snapshot.

The estimator walks object values, accounting for strings and approximate object/property
allocation without serializing another transcript copy. Shared objects are visited once; repeated
strings are conservatively counted separately. It stops when the budget is exceeded. This is an
estimated retention limit, not a measurement or bound on process RSS, transient scan allocation,
or the size of the current conversation.

An over-budget snapshot is not retained. It is never truncated: partial history must not be
presented as a complete catalog to deletion or ownership reconciliation. A later explicit full
scan reloads authorities; opening a historical Session continues to load only that Session.

The active runtime's pending events and the renderer's selected Session belong to independent
owners. Cache eviction does not dispose or mutate them. A second Main cache and a second selected
Session lifecycle are intentionally not introduced.

This refines the per-Session LRU wording in specification #15 / ticket #19: the existing cache has
one completeness-sensitive entry, so the implementation bounds and expires that whole entry.
Per-Session LRU would require new revision/invalidation and selection-ownership contracts while
adding no benefit to the existing on-demand read path. The initial limits are conservative
engineering defaults and should be assessed against measured retention and reload cost.

## Diagnostic fields

- Ready summary reads emit debug-level `mode`, `sessionCount`, `candidateCount`, `queueWaitMs`, and
  `summaryReadMs`. Debug level avoids an information-level event for every ordinary list read.
- Startup's catalog aggregate includes `mode`, overall `durationMs`, summary/hydrated counts, and
  whether an exceptional complete rebuild was needed.
- Full authority scans aggregate `sessionBytes`, `authorityReadMs`, and `jsonParseMs` separately.
  Read time measures file-reader calls, including failed attempts; parse time measures `JSON.parse`
  attempts. Directory enumeration, normalization, and repair remain in the enclosing phase timing.
- Hydration reports queue wait before entering its scheduler, existing per-phase durations, and
  `retainedSessionCount`, `retainedEstimatedBytes`, `cacheRetention`, `cacheMaxSessionCount`, and
  `cacheMaxEstimatedBytes`. Counts describe the cache, not independently owned runtime/renderer data.

Metrics contain counts, durations, modes, and outcomes. They do not include conversation bodies,
titles, or workspace paths. Scoped recovery conflicts/retries and background admission are reported
by their recovery owners; these cache metrics do not replace their durability checks.

## Scoped recovery commits

`prepareSessionRecovery` reads a bounded primary JSON snapshot without reserving the Project
persistence lane. It checks filesystem boundaries and file identity before and after reading.
This reader never promotes temporary files, removes them, or quarantines a primary. Temporary,
malformed, missing-primary, or changing-file evidence produces a `repair-required` handoff;
normal durable-file recovery then runs inside the guarded commit. No JSON format changes are needed.

`commitSessionRecovery` checks deletion/export guards, reloads authority, and compares the prepared
revision before upload, artifact, or file-index effects. It checks current runtime/preparation
ownership again and uses explicit revision comparisons on JSON saves. A stale candidate cannot
replace newer messages or metadata. `recoverStartupSession` reloads once after a revision conflict;
a second conflict remains a failure for the background owner to record and reschedule. Missing
Sessions return no result; unreadable authority throws and must not be counted as recovered.

This keeps historical primary reads from blocking a current Session's terminal save in the same
Project. Commit still uses the established Project-and-Session lane: already-started revalidation,
durable-temp recovery, and effectful repair are not preemptible. Synchronous JSON parsing also
still occupies Main's event loop. Background admission must yield between Sessions and avoid
queuing an entire catalog ahead of foreground work.

Recovery diagnostics use `operation: session-recovery` with prepare/commit/startup modes, phase
durations, commit `queueWaitMs`, and `revisionConflicts`. They contain no message bodies, titles,
or paths. These timings distinguish snapshot reading, persistence waiting, and effectful repair.


## Startup and deferred recovery ownership

With a ready derived projection, startup reads Session summaries and the selected Session only.
Listing summaries does not inspect every historical body and an oversized or unreadable historical
file does not initiate a full rebuild. Missing/old projection versions retain the exceptional
complete rebuild path; the JSON schema and authority do not change. Opening history hydrates that
Session through the existing continuation path.

The application composition starts `DeferredSessionRecovery` after foreground surfaces are wired.
It visits pending recovery candidates first, then streams the remaining historical Sessions so
legacy Upload upgrades, Artifact repair, finalized message snapshots, file indexing, Compute Host
bindings, sandbox approvals, and Session Details recovery retain their previous obligations.
Only one full body is held by the worker at a time; the completion catalog holds identities,
revisions, archive state, timestamps, and cwd references. It is not another transcript cache.
Compute Host and Session Details owners continue to protect work owned by the current process.

Each Session gets at most three attempts, with 250 ms and 1 s backoff. Failed Sessions yield to
healthy entries. Admission yields between reads, commits, and entries; it does not reserve future
Project lanes. Shutdown cancels future admission and waits for an already admitted effect, while
an off-lane primary read may finish without submitting a commit. Background failures are logged
locally and do not set the active Session's terminal-save error state. A later process reconstructs
work from JSON and summaries; there is no additional durable queue. Missing authority is rechecked
inside a scoped repository lane before removing only its stale projection. Unreadable/quarantined
or pending-import evidence keeps the summary.

The production integration test delays a historical primary read for more than 2.6 seconds and
proves a real same-Project runtime terminal save acknowledges within 1.5 seconds and survives a
new repository read. This does not promise preemption of synchronous JSON parsing, protected
commit effects, or exceptional durable-temp repair. An already admitted protected commit still
owns the Project lane and can delay same-Project foreground work for that commit.

## Complete cleanup boundary

Absence-based cleanup runs only after a successful complete sweep. Identity enumeration is
body-free and rejects incomplete temporary/import/deletion evidence. Every collected reference
must match the current summary revision (including legacy revision zero); a fresh catalog epoch
alone cannot validate an earlier cwd snapshot. Both the coordinator generation and repository
mutation generation must remain current through each destructive application. Package publication
through a second repository invalidates the coordinator generation before releasing its Session
lane, including failed publications. Repository mutation fencing covers durable-reader repairs.

Permission/index/provenance and archive cleanup use the complete identity set. Workspace planning
runs outside the global boundary, includes shared branch cwd references, and each action checks
freshness again. A failure is isolated where safe; uncertain or stale evidence defers destructive
cleanup until a later recovery. Active FileOriginSession witnesses preserve native import rows
published before JSON; deleting/deleted witnesses keep their existing retained-origin policy.
Explicit deletion receipts remain authoritative. Derived index rows without an identity or native
ownership witness remain eligible for orphan cleanup.

A second streamed pass cleans verified legacy Upload sources and orphan Artifact staging only
after the complete sweep. Upload sources must already have fully versioned references; cleanup
uses the existing immutable checksum/private-claim verification. Hashing runs under a scoped
Project/Session lane, outside the global catalog fence. The precheck alone is not a lasting fence:
known same-process writers are safe because package publication takes that same lane, live-save
upgrades references before commit, and direct repository writes reject legacy references. External
uncoordinated filesystem writers are outside that ownership contract.

Artifact directory planning runs outside global ownership. Application uses the artifact writer's
nonblocking Session reservation before entering the repository catalog fence, and rechecks
ownership, stat identity, grace period, and a fixed startup cutoff. Newly created staging from this
process is excluded. The callback must not invoke repository mutations under its catalog fence.
Busy writer ownership skips admission instead of waiting under the global boundary. Protected
filesystem deletion itself is not preemptible.

Deferred diagnostics report aggregate bytes, bounded read/parse timings, preparation and commit
timings, and existing per-phase index work. They never serialize transcripts merely to measure
size. Background retries/exhaustion and final counts are separate from foreground durability.
