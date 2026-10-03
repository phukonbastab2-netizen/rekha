import {execFileSync} from 'node:child_process';
execFileSync(process.execPath,['--test','tests/app.test.mjs','tests/rewards.test.mjs','tests/voice-effects.test.mjs','tests/send-queue.test.mjs','tests/scaling-ui.test.mjs'],{stdio:'inherit',timeout:180000});
execFileSync(process.execPath,['scripts/test-worker.mjs'],{stdio:'inherit',timeout:600000});
