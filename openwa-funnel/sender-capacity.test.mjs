import test from 'node:test';
import assert from 'node:assert/strict';
import { createSenderCapacity, dailyWorkload } from './sender-capacity.mjs';

test('10k daily workload counts the real first sequence, reminder and follow-up', () => {
  const model = dailyWorkload();
  assert.equal(model.initial.messagesPerDay, 50000);
  assert.equal(model.withOneReminder.messagesPerDay, 60000);
  assert.equal(model.withReminderAndAllFollowUps.messagesPerDay, 100000);
  assert.equal(model.initial.requiredMessagesPerMinute, 34.72);
  assert.equal(model.initial.maximumMeanServiceMsAtFullUtilization, 3456);
  assert.equal(model.timerDrivenStartsPerDay, 86400);
});

test('reports acceptance separately from uncertain results and never claims delivery', () => {
  let at = 1000000;
  const c = createSenderCapacity({ now: () => at });
  const first = c.started({ type: 'video', dueAt: at - 2000 });
  at += 4000; c.finished(first, { accepted: true });
  const second = c.started({ type: 'text' });
  at += 1000; c.finished(second, { accepted: false });
  const result = c.snapshot({ queued: 12, sending: 0, uncertain: 1, enabled: true, connection: 'connected' });
  assert.equal(result.observed.acceptedOperations, 1);
  assert.equal(result.observed.uncertainOperations, 1);
  assert.equal(result.observed.meanServiceMs, 2500);
  assert.equal(result.observed.p95ServiceMs, 4000);
  assert.equal(result.observed.maximumQueueWaitMs, 2000);
  assert.match(result.observed.evidence, /not delivered/);
  assert.equal(c.finished(second, { accepted: true }), false);
  assert.equal(JSON.stringify(result).includes('peer'), false);
});

test('scheduled steps do not trigger ready-queue warnings; stale ready work does', () => {
  const c = createSenderCapacity({ now: () => 1000000 });
  assert.equal(c.snapshot({ queued: 50000, oldestReadyAt: 1100000, enabled: true, connection: 'connected' }).warnings.length, 0);
  const result = c.snapshot({ queued: 4, oldestReadyAt: 900000, enabled: true, connection: 'connected' });
  assert.equal(result.queue.oldestReadyWaitMs, 100000);
  assert.match(result.warnings.join(' '), /one minute/);
});

test('rolling observations are bounded and expire without mutating any sender state', () => {
  let at = 1000000;
  const c = createSenderCapacity({ now: () => at, sampleLimit: 10 });
  for (let i = 0; i < 20; i++) { const token = c.started(); at++; c.finished(token, { accepted: true }); }
  assert.equal(c.snapshot().observed.completedOperations, 10);
  assert.equal(c.snapshot().observed.sampleTruncated, true);
  at += 600001;
  assert.equal(c.snapshot().observed.completedOperations, 0);
  assert.equal(c.snapshot().observed.meanServiceMs, null);
});

test('verified pre-send deferral and blocked outcomes never become uncertain or accepted', () => {
  let at = 1000000;
  const c = createSenderCapacity({ now: () => at });
  const first = c.started({ type: 'video' }); at += 20; c.finished(first, { deferred: true });
  const second = c.started({ type: 'video' }); at += 30; c.finished(second, { blocked: true });
  const result = c.snapshot({ enabled: true, connection: 'connected', blocked: 1 });
  assert.equal(result.observed.deferredOperations, 1);
  assert.equal(result.observed.blockedOperations, 1);
  assert.equal(result.observed.uncertainOperations, 0);
  assert.equal(result.observed.acceptedOperations, 0);
  assert.equal(result.observed.meanAcceptedServiceMs, null);
  assert.match(result.warnings.join(' '), /confirmed pre-send refusals/);
});
