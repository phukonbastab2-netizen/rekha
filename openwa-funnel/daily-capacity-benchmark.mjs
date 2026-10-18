// Synthetic local storage/queue exercise. No provider, HTTP client, browser,
// Cloudflare credentials, customer dataset, or production DB is opened.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Engine } from './engine.mjs';
import { dailyWorkload } from './sender-capacity.mjs';

const count = Number(process.argv[2] || 10000);
if (!Number.isSafeInteger(count) || count < 10 || count > 10000) throw Error('Choose 10–10,000 synthetic leads');
const workload = dailyWorkload({ leads: count }), initialSteps = workload.initial.messagesPerLead;
const reportPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (reportPath && fs.existsSync(reportPath)) throw Error('Report exists; refusing to overwrite it');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rekha-capacity-10k-'));
const dbPath = path.join(temp, 'synthetic.sqlite');
const start = performance.now(), budgetMs = 240000;
let virtualNow = Date.now(), base = virtualNow, engine, report;
const elapsed = () => performance.now() - start;
const exhausted = () => elapsed() >= budgetMs;
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));
const measure = (samples, fn) => { const start = performance.now(); const value = fn(); samples.push(performance.now() - start); return value; };
const stats = values => { const sorted = [...values].sort((a, b) => a - b); return { samples: sorted.length, p50Ms: sorted.length ? sorted[Math.floor(sorted.length * .5)] : null, p95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] : null, maxMs: sorted.at(-1) ?? null }; };
const inbound = [], dispatch = [], duplicate = [], pages = [], monitors = [], backup = [];
let seeded = 0, completed = 0, duplicates = 0, byType = {}, backupBatches = 0;

try {
  engine = new Engine(dbPath, () => virtualNow);
  for (let i = 0; i < count && !exhausted(); i++) {
    virtualNow = base + Math.floor(i * 86400000 / count);
    const input = { peer: `${880000000000 + i}@c.us`, id: `synthetic-in-${i}`, body: 'Synthetic benchmark only', type: 'text', at: virtualNow };
    const result = measure(inbound, () => engine.inbound(input));
    if (!result.accepted) throw Error('Synthetic lead was not stored');
    seeded++;
    if (i % 10 === 0) { const again = measure(duplicate, () => engine.inbound(input)); if (!again.duplicate) throw Error('Duplicate receipt was not suppressed'); duplicates++; }
    if (seeded % 100 === 0) await yieldTurn();
    if (seeded % 1000 === 0) console.log(JSON.stringify({ phase: 'synthetic-ingress', seeded, elapsedSeconds: Math.round(elapsed() / 1000) }));
  }
  const afterIngress = engine.stats(), seedElapsedMs = elapsed();
  engine.enable(true);
  while (completed < seeded * initialSteps && !exhausted()) {
    const t = performance.now();
    const job = engine.reserve();
    if (!job) {
      const next = engine.db.prepare("SELECT min(due_at) AS at FROM dispatch_heads WHERE lane='auto'").get()?.at;
      if (!Number.isFinite(next) || next <= virtualNow) throw Error('Queue stopped progressing');
      virtualNow = next; continue;
    }
    // This fabricated ID is confined to the disposable benchmark DB. No send API exists here.
    engine.finish(job.key, `true_${job.peer}_OFFLINE_BENCHMARK_${completed}`);
    dispatch.push(performance.now() - t); completed++; byType[job.payload.type] = (byType[job.payload.type] || 0) + 1;
    if (completed % 100 === 0) await yieldTurn();
    if (completed % 5000 === 0) console.log(JSON.stringify({ phase: 'simulated-acceptance', completed, elapsedSeconds: Math.round(elapsed() / 1000) }));
  }
  engine.enable(false);
  const afterQueue = engine.stats();
  for (let i = 0; i < 100; i++) {
    measure(monitors, () => engine.stats());
    measure(pages, () => engine.list('contact'));
  }
  while (!exhausted()) {
    const changes = measure(backup, () => engine.changes());
    if (!changes.length) break;
    engine.synced(changes.at(-1).seq); backupBatches++;
    if (backupBatches % 100 === 0) await yieldTurn();
  }
  engine.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  report = {
    syntheticOnly: true, requestedLeads: count, seededLeads: seeded,
    simulatedAcceptances: completed, expectedInitialAcceptances: seeded * initialSteps,
    completedInitialWorkload: seeded === count && completed === count * initialSteps,
    duplicateReceiptsSuppressed: duplicates, customerMessagesSent: 0, networkRequests: 0,
    workload, byType,
    seedElapsedMs, totalElapsedMs: elapsed(), budgetExceeded: exhausted(),
    queries: { inbound: stats(inbound), reserveAndFinish: stats(dispatch), duplicate: stats(duplicate), contactsPage: stats(pages), counters: stats(monitors), backupBatchRead: stats(backup) },
    afterIngress, afterQueue, backupBatchesSimulated: backupBatches, remainingSyntheticBackup: engine.stats().backupPending,
    databaseBytes: fs.statSync(dbPath).size, processRssBytes: process.memoryUsage().rss,
    machine: { arch: os.arch(), cpuCount: os.availableParallelism(), totalMemoryBytes: os.totalmem() },
    limits: 'Disposable SQLite benchmark on this host. Provider acceptance is simulated instantly. This does not validate WhatsApp throughput, account eligibility, delivery, browser CPU/media uploads, network bandwidth, real backup costs or 24-hour reliability.',
  };
} finally {
  engine?.close();
  // Only known files inside our freshly-created, resolved test directory.
  if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('rekha-capacity-10k-')) throw Error('Unexpected synthetic directory');
  for (const suffix of ['', '-wal', '-shm']) { const file = dbPath + suffix; if (fs.existsSync(file)) fs.unlinkSync(file); }
  fs.rmdirSync(temp);
}
if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify(report));
