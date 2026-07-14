# Security Policy

## Supported versions

Security fixes are applied to the latest published minor version of each `@korajs/*` package and the `korajs` meta-package. Older versions do not receive backports at this stage of the project.

## Reporting a vulnerability

Please do not report security vulnerabilities through public GitHub issues, discussions, or social media.

Instead, use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"), or email **bozomagroup@gmail.com** with the subject line `KORA SECURITY`. Include a description of the issue, steps to reproduce, the affected package and version, and any suggested remediation if you have one.

You will receive an acknowledgment within 72 hours. Expect a status update within 14 days. If the report is accepted, a fix will be developed privately, released as a patch version, and credited to you in the release notes unless you prefer to remain anonymous.

## Scope notes

The `@korajs/auth` package handles sessions, MFA, passkeys, and token encryption and is currently labeled experimental. Reports against it are especially welcome. Reports about the sync server (`@korajs/server`) should state whether the deployment used the memory, SQLite, or Postgres store and whether sync rules or rate limits were configured.
