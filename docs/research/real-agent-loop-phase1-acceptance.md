# Phase 1 Agent loop acceptance

Track the gates in [the English implementation plan](real-agent-loop-implementation-plan.en.md)
and [the original Chinese implementation note](real-agent-loop-implementation-plan.md) and
[spec #54](https://github.com/guch96/open-science/issues/54). An installed package, an Agent
turn, a Notebook dispatch, and verified files are separate observations.

## Final packaged MCP handoff: macOS arm64, November 20, 2026

- Final build: `2d2fbba9abba0d20e43e0a7af4974c7cdb88541a`, Node `24.22.2`, npm `11.19.1`.
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
| Final packaged install and user handoff ([#66](https://github.com/guch96/open-science/issues/66)) | Install both tarballs from the final commit. Start from the exact README quote, record same-profile user sign-in and recheck, then wait for a research request.                                                                                                                                        |
| First research ([#66](https://github.com/guch96/open-science/issues/66))                          | Supply values `10, 12, 14, 16, 18`. Use the real configured model and record Notebook dispatch for the same Run. Download the report and table with MCP, verify both against their source, and independently confirm count `5`, sum `70`, mean `14`. Export and inspect the actual `.science` archive. |
| Independent migration ([#67](https://github.com/guch96/open-science/issues/67))                   | Repeat from the README with only the first package on a separate machine or container. Inspect the imported Session without execution, get explicit user consent to Fork, then use a new request ID to add `20`. Check count `6`, sum `90`, mean `15` and verify the new report, table and package.    |
| Registry ([#68](https://github.com/guch96/open-science/issues/68))                                | Repeat on the officially published target version after release. No registry result is inferred from local tarballs.                                                                                                                                                                                   |

Record the build and environment, IDs linking requests to Runs and package operations, the actual
MCP calls, user decisions, Notebook dispatch, and file paths, byte counts and checksums. Omit
credentials and authentication URLs. Protocol fixtures and real Owner tests do not establish real
model or Notebook success.
