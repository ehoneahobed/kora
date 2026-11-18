---
'@korajs/cli': patch
---

`kora deploy --platform=aws-ecs` now reports only what happened. It checks the `ecsTaskExecutionRole` IAM role before building anything, and prints how to create it if it's missing.

- **No ECS service yet:** it says "Not deployed yet" and gives the `create-service` command. It used to print "Deployment completed" with a made-up URL.
- **Live URL:** it names one only when the service is behind a load balancer, using the load balancer's DNS name.

`DeployResult.liveUrl` can now be null, and the new `pendingSetup` field says what's left to do.
