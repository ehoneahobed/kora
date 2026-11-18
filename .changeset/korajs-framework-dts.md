---
'korajs': patch
---

`korajs/react`'s type declarations no longer import `@korajs/vue` and `@korajs/svelte`, which a React app doesn't install because they're optional peer dependencies. A React-only project with TypeScript's `noUncheckedSideEffectImports` and `skipLibCheck` off used to report them as missing modules. Each framework subpath's declarations are now built on their own.
