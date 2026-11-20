# Phase 1 Agent loop acceptance

Track the gates in [the implementation plan](real-agent-loop-implementation-plan.md) and
[spec #54](https://github.com/guch96/open-science/issues/54). An installed package, an Agent
turn, a Notebook dispatch, and verified files are separate observations.

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
