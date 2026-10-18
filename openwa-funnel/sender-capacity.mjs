// Operational measurements only: never sends, retries, changes queue state, or
// treats API acceptance as proof of delivery. Samples contain no customer data.
import { firstSequence, mediaSequence } from './funnel.mjs';

const DAY_MS = 86400000;
const WINDOW_MS = 10 * 60000;
const TYPES = new Set(['text', 'image', 'video', 'audio', 'ptt', 'document', 'sticker']);
const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const round = value => Math.round(value * 100) / 100;

export function dailyWorkload({ leads = 10000, concurrency = 2, pumpIntervalMs = 1000 } = {}) {
  if (!Number.isSafeInteger(leads) || leads < 1 || leads > 1000000) throw Error('Invalid daily lead target');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 20 || !Number.isFinite(pumpIntervalMs) || pumpIntervalMs < 1) throw Error('Invalid sender configuration');
  const scenario = messagesPerLead => {
    const messagesPerDay = leads * messagesPerLead;
    return { messagesPerLead, messagesPerDay, requiredMessagesPerMinute: round(messagesPerDay / 1440), maximumMeanServiceMsAtFullUtilization: round(concurrency * DAY_MS / messagesPerDay) };
  };
  return {
    leadsPerDay: leads,
    initial: scenario(firstSequence.length),
    withOneReminder: scenario(firstSequence.length + 1),
    withReminderAndAllFollowUps: scenario(firstSequence.length + 1 + mediaSequence.length),
    concurrency,
    timerDrivenStartsPerDay: Math.floor(DAY_MS / pumpIntervalMs),
    note: 'Arithmetic requirements only. Assumes all-day operation. Extra incoming-event triggers are not counted; WhatsApp permission, account limits, media upload time, failures and delivery are not validated.',
  };
}

export function createSenderCapacity({ now = Date.now, concurrency = 2, pumpIntervalMs = 1000, sampleLimit = 10000 } = {}) {
  if (!Number.isSafeInteger(sampleLimit) || sampleLimit < 10 || sampleLimit > 10000) throw Error('Invalid sample limit');
  const target = dailyWorkload({ concurrency, pumpIntervalMs });
  const startedAt = now(), active = new Map();
  let sequence = 0, completed = [], droppedSamples = 0;
  function trim(at) {
    completed = completed.filter(row => row.at >= at - WINDOW_MS);
    if (completed.length > sampleLimit) { droppedSamples += completed.length - sampleLimit; completed = completed.slice(-sampleLimit); }
  }
  return {
    started({ type = 'unknown', dueAt } = {}) {
      if (active.size >= 128) return null;
      const token = ++sequence, at = now();
      active.set(token, { startedAt: at, type: TYPES.has(type) ? type : 'unknown', queueWaitMs: Math.max(0, at - finite(dueAt || at)) });
      return token;
    },
    finished(token, { accepted = false, deferred = false, blocked = false } = {}) {
      const row = active.get(token); if (!row) return false;
      active.delete(token); const at = now();
      const outcome = accepted === true ? 'accepted' : blocked === true ? 'blocked' : deferred === true ? 'deferred' : 'uncertain';
      completed.push({ at, durationMs: Math.max(0, at - row.startedAt), queueWaitMs: row.queueWaitMs, type: row.type, outcome });
      trim(at); return true;
    },
    snapshot({ queued = 0, sending = active.size, uncertain = 0, blocked = 0, oldestReadyAt = null, enabled = false, connection = 'unknown' } = {}) {
      const at = now(); trim(at);
      const acceptedRows = completed.filter(row => row.outcome === 'accepted'), accepted = acceptedRows.length;
      const meanAccepted = accepted ? acceptedRows.reduce((sum, row) => sum + row.durationMs, 0) / accepted : null;
      const durations = completed.map(row => row.durationMs).sort((a, b) => a - b);
      const mean = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
      const observedSeconds = Math.max(60, Math.min(WINDOW_MS, Math.max(0, at - startedAt)) / 1000);
      const oldestWaitMs = oldestReadyAt && finite(oldestReadyAt) > 0 ? Math.max(0, at - finite(oldestReadyAt)) : 0;
      const counts = { queued: Math.max(0, finite(queued)), sending: Math.max(0, finite(sending)), uncertain: Math.max(0, finite(uncertain)), blocked: Math.max(0, finite(blocked)) };
      const warnings = [];
      if (connection !== 'connected') warnings.push('WhatsApp is not connected; ready messages cannot be sent.');
      if (!enabled) warnings.push('Automatic funnel replies are paused.');
      if (counts.uncertain) warnings.push('Some sends have an uncertain result and need owner review. They will not be retried automatically.');
      if (counts.blocked) warnings.push('Some customers are paused after repeated confirmed pre-send refusals. Review the sender before resuming them.');
      if (oldestWaitMs >= 60000) warnings.push('Ready messages are waiting over one minute. Reduce new campaign traffic until the queue recovers.');
      if (accepted >= 20 && meanAccepted > target.initial.maximumMeanServiceMsAtFullUtilization) warnings.push('Recent accepted send-operation duration exceeds the ideal budget for 10,000 initial funnels per day, even before other work and failures.');
      if (droppedSamples) warnings.push('Measurement sample cap reached; rate covers retained samples only.');
      return {
        measuredAt: at, processStartedAt: startedAt, windowSeconds: WINDOW_MS / 1000,
        queue: { ...counts, oldestReadyAt: finite(oldestReadyAt) || null, oldestReadyWaitMs: oldestWaitMs, note: 'Queued includes scheduled future steps. Saved customers and queued jobs are not live delivery capacity.' },
        observed: {
          completedOperations: completed.length, acceptedOperations: accepted,
          uncertainOperations: completed.filter(row => row.outcome === 'uncertain').length,
          deferredOperations: completed.filter(row => row.outcome === 'deferred').length,
          blockedOperations: completed.filter(row => row.outcome === 'blocked').length,
          acceptedPerMinute: round(accepted * 60 / observedSeconds), observationSeconds: observedSeconds,
          meanServiceMs: mean === null ? null : round(mean), p95ServiceMs: durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * .95))] : null,
          meanAcceptedServiceMs: meanAccepted === null ? null : round(meanAccepted),
          maximumQueueWaitMs: completed.length ? Math.max(...completed.map(row => row.queueWaitMs)) : null,
          activeOperations: active.size, longestActiveMs: active.size ? Math.max(...[...active.values()].map(row => Math.max(0, at - row.startedAt))) : 0,
          sampleTruncated: droppedSamples > 0,
          byType: Object.fromEntries([...new Set(completed.map(row => row.type))].sort().map(type => {
            const rows = completed.filter(row => row.type === type);
            return [type, { operations: rows.length, accepted: rows.filter(row => row.outcome === 'accepted').length, deferred: rows.filter(row => row.outcome === 'deferred').length, blocked: rows.filter(row => row.outcome === 'blocked').length, uncertain: rows.filter(row => row.outcome === 'uncertain').length, meanServiceMs: round(rows.reduce((sum, row) => sum + row.durationMs, 0) / rows.length) }];
          })),
          evidence: 'Provider API acceptance and operation timings only. This is not delivered/read confirmation and not a load test.',
        },
        target, warnings,
        capacityVerdict: '10,000 daily lead delivery is not verified. Storage benchmark and observed API timings cannot establish WhatsApp account or delivery capacity.',
      };
    },
  };
}
