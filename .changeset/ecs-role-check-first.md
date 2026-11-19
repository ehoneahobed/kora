---
'@korajs/cli': patch
---

`kora deploy --platform aws-ecs` now checks `ecsTaskExecutionRole` with the credentials, before it provisions or builds anything. Only AWS's not-found errors are reported as setup steps: `NoSuchEntity` for the role, `ServiceNotFoundException` or `ServiceNotActiveException` for the service. Any other failure, such as missing permissions, stops the deploy with AWS's message.
