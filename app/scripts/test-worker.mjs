import {execFileSync} from 'node:child_process';
// Integration checks must exercise the source being reviewed, never a stale bundle.
execFileSync(process.execPath,['cloudflare/package-deployment.mjs'],{stdio:'inherit'});
for(const file of ['test-scale-migration.mjs','test-onboarding-kundli.mjs','test-messaging.mjs','test-message-acks.mjs','test-history-scale.mjs','test-owner-send-scale.mjs','test-attachment-quota.mjs','test-calls.mjs','test-calls-scale.mjs','test-workflow.mjs','test-workflow-retry.mjs','test-workflow-cron.mjs','test-workflow-scale.mjs','test-cron-query-budget.mjs','test-app-settings.mjs','editor-integration.mjs'])execFileSync(process.execPath,['tests/'+file],{stdio:'inherit',timeout:180000});
