import { createCommand } from './commands/create/create-command'
import { runCli } from './utils/run-cli'

// Same failure handling as `kora create`: an expected error prints its message once, no stack.
void runCli(createCommand, process.argv.slice(2))
