# Phase 1 Agent loop acceptance

Track the gates in [the English implementation plan](real-agent-loop-implementation-plan.en.md)
and [the original Chinese implementation note](real-agent-loop-implementation-plan.md) and
[spec #54](https://github.com/guch96/open-science/issues/54). An installed package, an Agent
turn, a Notebook dispatch, and verified files are separate observations.

## Live first research: macOS arm64, November 20, 2026

- OpenCode `1.19.5` received the exact README quote with no attachment or research instructions.
  Its local stdio launcher installed npm `1.3.1` from a loopback registry serving this branch's
  `f937d9f5e` build, including the matching native package. The macOS CLI tarball used for the
  run had SHA-256 `ff1751e7bcdc9d401b32222691d2799e413dbd71cd764ebd352821d0582bb8e5`, and the
  native tarball had SHA-256 `05e2d9e68a9c2d35fb4c0a288b8eb2951e131c2a3acdbfede84c51824ed42361`.
  The initial launcher failed under the test's synthetic home; starting the same installed CLI
  in the normal OS user context with `start --no-open --port 0 --profile` succeeded. The Agent
  found the guide and catalog, reported the missing provider/Python and actual memory pressure,
  and stopped without submitting research.
- The test operator used Web onboarding to choose the built-in keyless Kilo Gateway and install
  managed Python `3.12.16`, then used Model Settings to test the connection. OpenCode rechecked
  the same profile; research was authorized separately once the memory policy reported ready.
  No account credentials were transferred or entered through MCP. This demonstrates a real
  same-profile provider setup, not a completed Codex OAuth login.
- `synthetic-stats-first-study-001` was rejected before Run creation because the Agent supplied
  the not-yet-created download directory as `cwd`. `-002` and `-003` did not complete the study:
  the Ask-policy turn's explicit `notebook_bind_runtime` outcome was unknown. The test retained
  the original receipts and authorized a fresh turn using default Python and the Auto policy.
  The guide/schema now explain the working-directory default and the Notebook tool description
  explains when an explicit runtime selection is needed. Neither change authorizes a missing
  permission or replays a failed request.
- `synthetic-stats-first-study-004` resolved to Run `aa436e83-ed2f-48b0-b99d-08449579bf62`,
  Project `cmwosb6jp0000jgfz5fr528yn`, Session `b8241418-713a-4463-a510-f917c50b6d3e`.
  The real built-in Agent used Kilo's `kilo-auto/free` route. Notebook Run
  `notebook-run-1795167689906-3` reported `completed`, `kernelDispatched: true`; service logs
  also recorded a real dispatched Python cell. One bounded `wait_run` timed out; observation
  of the same Run later completed. After stopping and starting the local service, MCP
  `get_submission` returned the original accepted receipt and `get_run` returned the same
  completed Run and Notebook dispatch evidence. No new Run was submitted for this recovery.
- OpenCode used only MCP for research, Artifact downloads, and export. The test read both
  downloaded files and independently checked the inputs `10, 12, 14, 16, 18`, count `5`, sum `70`,
  mean `14`, min `10`, and max `18`. A same-Run `get_delivery_status` with the chosen local paths
  returned `handoffStatus: complete` and `delivery.status: verified`.

| File | Download or operation ID | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `stats_report.md` | `d123ce6c-faab-48b7-9175-1bb057a8e9ad` | 717 | `795a4c0a0a046b074220ef088b894604f7885e93693e210f0963049833237bb2` |
| `stats_results.csv` | `5be63a7c-843c-4f92-8f65-7b88844b5dd8` | 37 | `6f0ec537637ce5de3ad68d1ba4da9a0599768815f8077134a587f6802781d3c9` |
| `first-study.science` | `d7502d20-befd-4484-ad13-e03a21117f50` | 220810 | `8b30109c9e684f26318d10895f9a2bf19954a6947ca67eba53b28bc8ab26babd` |

The original export lookup returned the completed operation and verified file. The archive's
21 inventory records describe 16 unique archive entries (including the manifest); each listed
size and checksum was independently checked. The inventory includes the actual Notebook and
published result bytes. No credential files were transferred. The Linux receiver reproduced
the source archive SHA-256 before import.

The real expired Codex login trial before this build returned `preparation_failed` for a confirmed
ACP authentication error. The fix persists `provider_auth_required` on that original failed
receipt and projects a sanitized, same-profile user action. Owner tests cover the restart and
deduplication case; real stdio and CLI JSON regressions verify the same projection on all three
receipt commands. It does not change read-only doctor into an online provider probe.

## Live independent migration: Linux arm64, November 20, 2026

- The receiving Open-Science service and MCP host ran as an unprivileged user in a new Debian 13
  Docker container, Node `24.22.3`, Open-Science `1.3.1` from `f937d9f5e`. It mounted no host
  directories and had its own profile, D-Bus and unlocked Secret Service. Only
  `first-study.science` crossed over as research state. The receiver verified its source hash
  before import. The native package SHA-256 was
  `26726de6ad57e5ce8659d79dc86adfc0b18471ff9ecdc3fca3e97d37ff722f82` and the CLI SHA-256 was
  `4b90aef6fe7dc241ef48ca9491d075bd4cd0189b316aab9efd07fa83d13b4db8`.
- Debian 12 did not load the pinned native credential executable (`GLIBCXX_3.4.32` missing);
  Debian 13 provides the required C++ runtime. The container used host cgroup visibility and
  permitted nested namespaces and private procfs mounts. The actual bubblewrap probe passed,
  as did the service's Linux sandbox and memory checks. No app protection or credential check
  was disabled. The operator installed managed Python through the Open-Science Web onboarding.
- OpenCode's CLI could not attach the binary archive directly. The local path represents the
  attachment for a stdio MCP host. The first hosted model hit HTTP 429 before import, and an
  OpenCode trial with a smaller local model did not select the import capability. A separate
  Codex Agent with fresh context received the exact README quote, the local attachment path and
  a generic stdio connection relay. The relay ran entirely in the target container; there was
  no CLI fallback for business calls. The target Open-Science profile independently validated
  a keyless Qwen3-4B-Instruct-2507 model via a local llama.cpp inference service. The inference
  process did not mount either profile or receive credentials.
- The Agent discovered capabilities, checked readiness and imported the real archive. Import
  `cabfa679-2f9c-411e-bb09-e80c1c52a450` (correlation
  `eb4225d3-f3bf-4757-a493-c8a39632f210`) created Project
  `import-332e8800-e46e-4562-92ad-94fa7f9f1ac1` and Session
  `import-37c3aa7f-ce78-49b8-8052-f8bd60b61382`. `get_session` returned `readOnly: true`;
  `list_artifacts` returned `stats_report.md` and `stats_results.csv`. The Agent reported the
  historical values and stopped without executing the Notebook or creating a Fork. The test
  operator then sent a separate user turn explicitly authorizing the Fork and a new study.
- MCP `get_package_operation` confirmed that import. `fork_session` and an independent
  `get_package_operation` lookup confirmed Fork operation `bc95eaea-70a9-4950-91ce-bbef86fa654c`
  (correlation `27d9b67a-b59b-47f5-a583-1ad5dfccf9aa`) and writable Session
  `47568d10-c43b-4361-9393-91c4ff2ecba9` in the receiving Project. The original Session
  remained read-only. A local historical CSV downloaded through MCP was 37 bytes and had the
  same SHA-256 as the source CSV above. Both `stats_input.json` and `stats_results.csv` from
  the package were present in the Fork's Notebook data directory.
- The first follow-up, request `f17b230f-7e96-402e-9d85-855106d54e3c`, reached real local
  inference on Run `5177b0c9-ce67-4480-ae4a-a60d98129b03` without dispatching a Notebook
  cell. The operator explicitly cancelled the Run. A separate MCP read returned `cancelled`,
  no Notebook execution or refusal, and missing report and CSV. No package was requested for
  that Run, and its request ID was not reused.
- The authorized retry `dab298c1-4aaf-4570-b1c2-36922e805a2e` became Run
  `effef533-61bf-4fff-9197-31dda7fa73c3`. The original Web Session showed pending code review
  for Notebook Run `notebook-run-1795170072476-1`. MCP `get_run` reported `running` and
  `wait_run` timed out without a user action. The test operator reviewed the synthetic code and
  used **Allow** in the original Session. The same Notebook Run then reported
  `kernelDispatched: true` and a Python `SyntaxError`: the model emitted literal `\n` outside a
  string. The operator did not approve a second cell with the same error. A fresh MCP client
  confirmed cancellation, no new Artifacts, and missing delivery; no export was attempted.

### Agent, MCP and service in the same receiving environment

- OpenCode `1.19.5` ran inside the Debian 13 container on an empty Open-Science profile, with no
  shared source files beyond the same verified archive. The initial stdio service startup could
  not infer an OS vault on the headless host. An explicit CLI startup with the already unlocked
  Secret Service and the same profile resolved it. README now links this Linux prerequisite at
  the MCP setup step. There was no CLI fallback for package or research operations.
- Given the unchanged README quote and the attachment's local path, OpenCode called readiness,
  discovered capabilities, then imported and inspected the read-only Session. Import operation
  `61cd9043-296f-45a7-90ab-7ef7dbd2b064` (correlation `94c19c96-128c-479d-9c2d-19e6d450f6f8`)
  returned Project `import-aaf4145c-62fd-4824-ba1b-cc3b5e13d725` and read-only Session
  `import-4ecc4a69-8196-4a81-8670-7dcd928d04bb`. `list_artifacts` returned the same report and
  CSV. The Agent then asked for Fork permission. The test operator installed managed Python
  `3.12.16` through Web onboarding, configured the target provider independently, and explicitly
  authorized the Fork and study in a new user turn. Fork `191af3bc-ba7b-46f4-bc1f-d98ee47f92a6`
  (correlation `ec041c95-45d3-4968-91e0-1655150e7fb6`) created writable Session
  `9fcdf9cb-bb4d-4e1f-8e10-8e77a053af02`. Separate operation lookups confirmed both receipts.
- The Agent initially used `requestId` as `runId` and passed new-Session settings when submitting
  to the Fork. The shared capability descriptions now distinguish those inputs, and pending
  receipts include a `wait_submission` action carrying the original `requestId`. The model
  gateway returned HTTP 429 on the first accepted Run `519ca028-7178-438a-a671-4dd52ec288bc`.
  The operator tested keyless local inference and set the model on the Fork itself. Changing the
  profile default did not replace a previously saved Session selection.
- The initial 32K local context budget was insufficient for the configured tools and the replayed
  history. Request `phase1-migration-review-1120`, Run `62cf5993-d3fb-4571-ab16-14d4c6264252`,
  stopped at `max_turn_requests` before sending a model request, but the old outer Run said
  `completed`. That Run had no Notebook or delivery evidence. The repair makes both turn-budget
  and output-budget stops fail the original Run with an actionable message, preserving any
  partial output. The operator set the real llama.cpp context and the provider declaration to
  65,536 for the next attempt; no Notebook or service protection was changed.
- With the installed `7db3f7cb6` build, request `phase1-migration-reviewed-study-1120`, Run
  `b691f39a-d15a-4418-8513-d8f6a96279d1`, reached a real pending review on Notebook Run
  `notebook-run-1795172249682-1`. MCP `get_run` and `wait_run` and CLI JSON `wait_run` all
  reported `waiting_for_user`, `kernelDispatched: false`, and `review_notebook_code_in_app`
  for the same Session and branch. The test operator selected Deny for an invalid cell and
  explicitly cancelled that Run. No cell from that Run was dispatched. The final implementation
  reads review state from the permission broker, so the handoff survives UI evidence trimming.
  Regression tests cover the wrong branch, approval settlement, and redacted public events.

### Verified continuation and second delivery

- The operator supplied a short calculation cell after the model syntax failures. Codex drove
  the repaired follow-up through the target container's installed stdio, with no CLI business
  calls. This was a guided rerun in the same authorized Fork after the in-container OpenCode
  import and Fork. The earlier attempts remain recorded; OpenCode did not finish the whole
  sequence in one unattended conversation.
- New request `phase1-migration-print-study-1120` returned the pending receipt and explicit
  `wait_submission` action, then accepted Run `16837110-d44b-4df4-8130-782ae2fb5526` on the
  existing Fork. The real Qwen3-4B model requested `notebook_execute`; default Python Notebook
  Run `notebook-run-1795172442611-2` completed with `kernelDispatched: true`. The cell read the
  migrated `stats_input.json`, appended `20`, and produced `6,90,15.0,10,20`. The model published
  both files as Artifacts with that Notebook producer ID. The MCP list scoped to the research
  Run returned only those new Artifacts. The original imported Session remains read-only.
- Both Artifacts were downloaded through MCP and verified against their source version bytes
  and checksums. `get_delivery_status` returned `handoffStatus: complete` for this Run.
  Export operation `60d0068f-5e62-47a9-831e-3aa05c0349c0`, correlation
  `bb2c72a7-e15c-4731-8645-3c64f73a9a16`, completed; the original operation lookup confirmed
  it and the delivered package. The archive contains the new Notebook and Artifact contents.
  All 32 inventory records and 23 unique archive entries were read back and verified; the
  archive paths contained no credential files. The report and CSV were read independently and
  the results recalculated from the input.

| File | Download or operation ID | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `followup_report.md` | `4e771478-8b0a-4f80-8471-0922ebe1b3f7` | 154 | `60e82b32006765ee44886ab93f20af4db8b21396a8d281be04daff906bae485b` |
| `followup_results.csv` | `4bdf31a6-2082-4b11-844e-04421d5a8e11` | 41 | `6f141f51adb0b0bde0baed696b27286a6c11d694960cbe173e844cae937e0254` |
| `followup-study.science` | `60d0068f-5e62-47a9-831e-3aa05c0349c0` | 499414 | `aa15a387ffc592d418dc85f6b7f10edf375c4f7d8707b82b5f225cfe7cee3b7b` |

The receiving service and MCP were then switched to the matching CLI/native npm build from
`57f5c52ce`. After the service restart, that installed build returned the original accepted
receipt, the same Run and Notebook dispatch, and `handoffStatus: complete` for the same files.
No work was resubmitted for this recovery. A separate low-context trial on that build,
request `phase1-budget-repro-1120`, Run `b9df8f56-a7ec-4139-9c4f-42d951943bfc`, returned
`failed` and the same model-limit explanation from CLI JSON and MCP. It did not claim Notebook
execution or delivery. The macOS and Linux package builds both passed `test:npm-installed`;
the focused contracts and Owner test run passed 1,058 tests across 17 files.

### Exact README replay with Ask permissions

- A new receiving profile in the Debian container installed the matching `57f5c52ce` CLI and
  native tarballs (SHA-256 `b42ffcd4107b9fe148a40ee08663d926636bbec09105728e655834a71196422e`
  and `55e70daaa1baa4b8a31757cac2af873b00938650c66b335d73de8fe680b16dbd`). The inbound archive
  matched the first-study digest. OpenCode used the exact README quote and attachment path, with
  only its normal local stdio connection configured. It used `get_setup_status`, `import_session`,
  `get_session`, and `list_artifacts`, then waited for user permission to Fork. Import
  `0560b8e9-586c-43cb-a9c4-e991fdec55d1` created Project `import-37121da8-3456-49e1-a9bd-2f4a517ab5f1`
  and read-only Session `import-7a2ac913-27d6-4ea8-99a7-00a2c37234ff`.
- The test operator independently validated the local Qwen3.5-9B model and provisioned managed
  Python. In the same OpenCode conversation, the operator authorized a Fork and provided a
  statistics question and expected files. MCP Fork `fa52325e-dc2a-4d5f-b197-508a609a6167` created
  writable Session `2ac4794f-bb8f-4c7c-9568-ef34a9cab357`. OpenCode submitted
  `continued-study-run-001`, called `wait_submission` on the pending receipt, then followed the
  accepted Run `b7b08c56-c460-4999-8e82-710be907a07a`. A bounded wait timed out and OpenCode
  queried the original Run rather than submitting another one.
- The built-in agent read the migrated input and called `notebook_execute`. The Session was
  waiting for the Web app's **Confirm Notebook kernel and environment** decision, which happens
  before a data Notebook Run exists. The old build's public `get_run` returned `unconfirmed`
  while `wait_run` timed out. After the operator confirmed the managed Python environment in the
  original Session, that same Run immediately exposed its separate code review as
  `waiting_for_user` with `kernelDispatched: false`. The operator denied a cell with an invalid
  Python import and an unintended write to the source input. No dispatch or delivered output was
  credited to that cell.

### Desktop handoff regression

Three Playwright Electron tests passed against the `57f5c52ce` build: restart with a new explicit
Notebook **Continue Notebook work** action followed by Allow or Deny, and a real stdio sensitive
export held until Desktop review. The continuation tests use a deterministic provider. The
sensitive export test uses synthetic content and simulates only the operator's selection in the OS
dialog; it verifies that the app defaults to Cancel and publishes the exact reviewed candidate.

## Earlier packaged MCP handoff: macOS arm64, November 20, 2026

- Build: `2d2fbba9abba0d20e43e0a7af4974c7cdb88541a`, Node `24.22.2`, npm `11.19.1`.
  `npm run stage:backend`, `npm run pack:npm-release`, and `npm run test:npm-installed`
  passed on this commit. The latter confirmed real npm resolution, the npx entry point,
  native loading, and an Electron-free install.
- SHA-256 of the final CLI tarball:
  `49b6bca1d5187e58bc4f673381615526363fad129d47d19abe596f46311f670a`.
- SHA-256 of the matching macOS arm64 tarball:
  `8f3bfbeea258f7aef3fb192395eeda357b4f046e35e9ddec0c23ab0a2b9f1964`.
- A clean temporary npm install launched the installed `open-science mcp --profile` executable
  over real stdio. The client read `openscience://agent/guide`, discovered the package tools,
  and used the repository's `session-package-v0.31.1-minimal.science` fixture. The first attempt
  was blocked by a stale development process holding port `44100`; after that process was stopped,
  the same packaged flow completed on a fresh profile without changing product code.
- Import operation `411a9ad1-d98c-432a-89d7-98de9e57ec58` created Project
  `import-9511f28a-2f69-407f-94e7-08186f4825fe` and read-only Session
  `import-53c9938b-afd3-4aae-b58f-3594a1638b76`. A matching `get_package_operation` lookup
  confirmed the completed import, and `get_session` confirmed `readOnly: true`.
- Fork operation `f3261550-f55d-4e15-9b87-a547c416c91d` returned writable Session
  `f3586e5e-f2d0-4fe3-b1f3-4e600baaf47f`; its original operation lookup also completed.
- Export operation `5cf2de97-9eb7-4d6e-a6f4-d3ac0e531d7a` published `final-fork.science`.
  The delivery was `verified`, the file was 2325 bytes, and its independently checked SHA-256
  was `71679574e24930ccb7db96d5da153662daf438ff7360e8fe69fdfc302e324178`. The archive inventory
  contained `README.md`, `manifest.json`, `records.json`, `ro-crate-metadata.json`, and `session.json`.
- This is packaged protocol and Session-package evidence only. The fixture has no research result
  artifacts, real provider/model call, or Notebook dispatch, so it does not close the first-research,
  independent-migration, or registry gates below.

## Packaged preview: macOS arm64, November 20, 2026

- Build: `02497ab0e350c9a33cef4bcbe875ba2d7ea9185e`, Node `24.22.2`, npm `11.19.1`.
  `npm run stage:backend`, `npm run pack:npm-release`, and `npm run test:npm-installed`
  passed. npm selected both staged `1.3.1` packages; the native dependencies loaded without Electron.
- SHA-256 of the CLI tarball: `82b0299003f5a66d19a2e56f00cf73fd75e12967a2f866b5c4e2f368973b9860`.
  SHA-256 of the matching macOS tarball: `b8b625e2439cb02c7109735e47da3bee772d1090129a9a187ca42e51b05223dd`.
- A fresh Codex CLI `0.169.0-alpha.11.1` conversation received the exact README prompt and
  no package or research data. npm installed from a temporary loopback registry serving the
  staged tarballs. Host configuration writes were denied by the Codex workspace sandbox. With
  the local MCP launch configured for the test session, Codex read the guide and catalog through
  stdio. The initial host connection could not reach the intended service. Explicitly passing
  `--profile` to the MCP launcher resolved profile selection; the same Codex conversation then
  completed capability discovery, Project listing and the setup check. The agent reported the
  missing provider and Notebook prerequisites, then waited without submitting research.
- A separate MCP SDK client launched that same installed executable with a new profile. The
  service started, the guide resource and Project listing worked, and `get_setup_status` reported
  the service ready, provider missing, default Python missing, and host memory pressure. The
  provider handoff named the installed CLI, selected profile and same-profile verification step.
- On the local Docker default deployment, a clean Linux container with bubblewrap could not
  create the namespaces needed by `bwrap --unshare-all --ro-bind / / --proc /proc --dev /dev -- true`.
  This establishes a deployment constraint for that configuration. No product protection was changed.

## Packaged Session handoff preview: macOS arm64

- Build `d012d48dd`: actual CLI and native npm tarballs installed from a loopback registry;
  native loading and the Electron-free install check passed. CLI SHA-256:
  `907203a4033a115af1f29481e0ea5ed20d3c67340e1909918f70bdc84c725a5e`.
  Native package SHA-256: `0a12c72acb6b05b55f060858f025369190ccfb38d94c582248970d32e79433a9`.
- A fresh profile used MCP stdio to import the repository's `v0.31.1-minimal` fixture and read
  back the same read-only Session. Import operation `bc79e0d1-a6cb-4451-b885-0c49e6cb336f`
  returned Session `import-d9c98023-ce0b-439c-b110-0687e0a40f54`. Fixture-authorized Fork
  operation `91a4aaa4-c41a-423d-92bb-b803733fa60d` returned writable Session
  `2a418ecc-bf9c-4a7c-b324-a91c028968de`. The original operation lookup matched each result.
- Export operation `e057d894-57bc-407b-bdc4-bf426ad4145a` published `packaged-fork.science`,
  2316 bytes, SHA-256 `fb6a78a4cec91990d9fe8f137343d3ed48c128a66aaf38111c58469e28a70f3e`.
  The local file matched the Owner's receipt; its archive inventory contained `session.json`,
  `records.json`, `README.md`, and `ro-crate-metadata.json`.
- A separate Codex conversation on the same machine received the exact README quote and this
  package in a fresh profile. It called the guide, catalog, doctor, `import_session`,
  `get_session`, `list_projects` and `list_artifacts` over MCP. It identified the read-only
  Session `import-10a06ec5-31d7-48e7-8de3-6caec7281eba` and waited for permission to Fork.
  The fixture has no results to deliver. The agent did not call `fork_session` or `start_run`.
- Scope: actual packaged service and local files, with an archive fixture and separate profiles.
  No real model call to Open-Science, Notebook dispatch, fresh machine, or registry release.

## Remaining gates

| Gate                                                                                              | Evidence required                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Registry ([#68](https://github.com/guch96/open-science/issues/68))                                | Repeat on the officially published target version after release. No registry result is inferred from local tarballs.                                                                                                                                                                                   |

Record the build and environment, IDs linking requests to Runs and package operations, the actual
MCP calls, user decisions, Notebook dispatch, and file paths, byte counts and checksums. Omit
credentials and authentication URLs. Protocol fixtures and real Owner tests do not establish real
model or Notebook success.
