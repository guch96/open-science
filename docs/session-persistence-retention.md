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
