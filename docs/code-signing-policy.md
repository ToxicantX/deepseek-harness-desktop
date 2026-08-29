# Code signing policy

Free code signing for eligible DeepSeek Harness Desktop Shell releases is provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

Until the SignPath integration is approved and active, published and local artifacts may remain unsigned. The signature status shown by Windows is the source of truth for each file.

## Scope

- The project signs only Desktop Shell artifacts built from this repository by the `Build Shell` GitHub Actions workflow.
- The project certificate is not used to sign Runtime archives or upstream projects' binaries.
- Release tags, source code, build scripts, and workflow definitions remain publicly auditable in this repository.
- Every signing request requires manual approval by a designated project approver.

## Team roles

- Committer and reviewer: [ToxicantX](https://github.com/ToxicantX)
- Signing approver: [ToxicantX](https://github.com/ToxicantX)

Project members with repository or signing access must use multi-factor authentication. Contributions from people without direct commit access require maintainer review before they can enter a release.

## Privacy

The Desktop Shell does not operate project-owned analytics or telemetry services. It contacts GitHub Releases to check for Shell and Runtime updates, and it connects to model providers or other services only when configured or requested by the user. Those third-party services have their own privacy policies. Local sessions, settings, plugin configuration, and credentials remain in the user's configured DSH data directory unless the user directs the application to send content to a configured service.

## Verification

Download releases only from the project's [GitHub Releases](https://github.com/ToxicantX/deepseek-harness-desktop/releases) page. For signed files, Windows should report a valid Authenticode signature whose publisher is `SignPath Foundation`. Historical releases may be unsigned.
