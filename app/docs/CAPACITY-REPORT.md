# Local capacity validation

The completed run stored **100,000 customer profiles and 504,995 messages** in a real temporary Miniflare D1 database. All **190 authenticated Worker API requests** succeeded. Indexed reads stayed bounded by a chat, page, candidate window or queue instead of reading the full registered population.

This validates the tested data volume and short local request bursts. It does **not** establish 100,000 simultaneous online customers, a production service guarantee, the account's subscription tier, or unlimited free usage. No production traffic, plan change, new paid binding or cloud load test was used.

Run started **2026-10-03 06:08:13 UTC**. Runtime: Node **v24.19.0**, Windows, Intel Core i5-2500, four logical CPUs, approximately 8 GB RAM; Miniflare **5.20260921.0-alpha**. The [raw results](capacity-results.json) include source hashes, exact SQL, query plans, reported D1 row counts and individual requests.

## Data volume and storage

| Fixture | Verified quantity |
| --- | ---: |
| Registered customer profiles | 100,000 |
| Base chat messages, five per profile | 500,000 |
| Additional messages in one long chat | 4,995 |
| Long chat's complete history | 5,000 messages |
| Ended call history | 105,000 calls; 5,001 belonging to one customer |
| Populated workflow-event history | 100,000 events |
| Extra workflow recovery messages | 1,001 |
| Workflow jobs | 1,000 current jobs, including 500 held; 2,000 cancelled historical jobs |
| Profiles/messages database before extra stress fixtures | 248,586,240 bytes, approximately 248.6 MB |
| Largest measured database during additional pending/call/workflow stress | 454,901,760 bytes, approximately 454.9 MB |
| Database after the retention probe | 450,052,096 bytes |

These sizes include tables and indexes, but no uploaded R2 media files. Message bodies are short synthetic text, so a larger average message body or retained history increases storage. The pending-population stress also changes indexes and allocates database pages. A profile count alone is insufficient to predict future storage.

Initial profiles/messages setup took 31.1 seconds locally and reported 2,625,127 rows read and 5,902,503 rows written. This bulk setup deliberately runs only in the local fixture; it would exceed the documented Free daily D1 write allowance if copied into production in one day.

## Authenticated API evidence

The local-only adapter records all D1 statements completed before each HTTP response. It separately counts background tasks; the tested reads below created none and wrote no rows. D1 row counts are reported by Miniflare's D1 metadata, not inferred from result lengths.

| Request | Result | Rows read | Rows written | Background tasks |
| --- | --- | ---: | ---: | ---: |
| Long chat, latest page | 80 messages | 1,123 | 0 | 0 |
| Long chat, previous page | 80 messages | 1,123 | 0 | 0 |
| Unchanged chat delta | 0 messages | 6 | 0 | 0 |
| Owner inbox, first page | 50 customers | 230 | 0 | 0 |
| Owner inbox, next page | 50 customers | 232 | 0 | 0 |
| Broad name prefix `Customer` | 50 customers | 329 | 0 | 0 |
| Absent name prefix | 0 customers | 3 | 0 | 0 |
| Broad prefix with an empty waiting filter | 0 customers | 3 | 0 | 0 |
| Unique name prefix | 1 customer | 5 | 0 | 0 |
| Customer call poll after 5,001 own ended calls | 0 active calls | 8 | 0 | 0 |
| Owner call poll after 105,000 ended calls | 0 active calls | 8 | 0 | 0 |
| Manual chat with unanswered messages | 6 messages | 88 | 0 | 0 |
| Blocked chat with unanswered messages | 6 messages | 89 | 0 | 0 |
| Paused guided chat with unanswered messages | 6 messages | 91 | 0 | 0 |
| Assisted chat with a current completed draft | 6 messages | 92 | 0 | 0 |

The latest-history SQL itself read 81 rows using `messages_conversation`. Full API reads additionally decorate the selected page with permissions, receipts, stars and reactions. The unchanged history SQL read one row using the revision index; the complete authenticated API read six.

Name searches use an indexed prefix range and an index for the selected filter. The absent/rare-filter probes matter: applying a small result limit after examining every matching name would still read all 100,000 profiles. Their measured row counts and query plans show that this tested path avoids that scan.

## Limited local concurrency

Each burst sent one unchanged chat poll from each of the indicated authenticated customers. The 175 burst requests formed part of the 190-request total. Every burst request read six rows, wrote zero and created zero background tasks.

| Concurrent requests in the short local burst | p50 latency | p95 latency | Maximum latency | Total rows read |
| ---: | ---: | ---: | ---: | ---: |
| 25 | 585 ms | 586 ms | 586 ms | 150 |
| 50 | 966 ms | 969 ms | 969 ms | 300 |
| 100 | 1,675 ms | 1,680 ms | 1,681 ms | 600 |

These timings include the local Worker/D1 adapter and this desktop's scheduling. They are not Cloudflare edge latency predictions. The run did not sustain these clients for a full day, perform a production throughput test, or test 100,000 concurrent sessions.

## Workflow, cron and retention evidence

| Exact query/probe | Result | Rows read | Rows written |
| --- | --- | ---: | ---: |
| Historical user-message recovery cursor | 200 candidates | 200 | 0 |
| Empty workflow recovery queue | 0 messages | 1 | 0 |
| Populated workflow recovery queue | 20 messages | 40 | 0 |
| Recovery queue restricted to one chat | 1 message | 3 | 0 |
| Due-job query with 500 held jobs elsewhere | 20 eligible candidates | 60 | 0 |
| Idle due-job guard with 2,000 cancelled jobs in that chat | 0 jobs | 2 | 0 |
| New enrolled customer inbound, including queue insertion | 1 inserted message | 7 | 19 |
| Each fair cron candidate window | 200 profiles | 650–701 | 0 |
| Empty production retention page, limit 25 | 0 profiles | 1 | 0 |
| Expanded retention selection probe, limit 100 | 100 expired profiles | 100 | 0 |
| Expanded retention cascade probe | 100 profiles and their related data | 68,772 | 13,197 |

The queue replaces repeated searches of all messages without workflow events. Historical migration recovery advances an id cursor through at most 200 user rows at a time; reapplying the migration preserves progress. Event insertion, job creation and recovery-queue removal use one atomic batch. Queue and event foreign keys clean up when a message or profile is deleted.

Held jobs retain their original due time and are excluded from normal pending/processing indexes. Paused/manual/blocked transitions affect only the selected conversation. Delivery still checks the current lease, generation, owner mode and blocking state before inserting a message. The focused workflow tests cover a paused backlog larger than a scheduler page, resumption, concurrent delivery, takeover during media acquisition, restart cancellation and deletion.

Cron materializes at most 200 waiting candidates using a persisted `(updated,id)` cursor. Manual and blocked profiles are excluded by its partial index before that window. The mixed guided/drafted fixture required four windows of skipped candidates before the fifth reached the deliberately later eligible chat. This proves bounded cursor progress; it does not promise that every eligible chat is answered in one cron invocation. The runtime query budget can defer work to later invocations.

Retention selection uses `conversations_retention`. The expanded 100-profile cascade is a diagnostic probe, larger than the production 25-profile page. It intentionally includes the long chat, long call history and populated workflow events. Cascade cost scales with the selected profiles' retained data, rather than being a constant number of writes per profile. The `workflow_events_message` child-key index prevents deleted messages from searching all unrelated events; the populated-event plan uses it.

Separate `tests/test-workflow-scale.mjs` checks showed that a 20-query allowance examines one recovery message and leaves three remaining entries durable, and a 30-query allowance completes one delivery step. Shared runtime budget guards reserve work before starting a unit; they do not interrupt an atomic delivery batch.

## Current-plan boundary

No account subscription or resource configuration was changed. The actual subscription could not be established from this local test, so **Free-plan documentation is a conservative reference, not a claim about the account's confirmed tier**. Official limits were checked on 2026-10-03.

| Conservative documented reference | Limit |
| --- | --- |
| Workers Free requests | 100,000 per day |
| Workers Free CPU | 10 ms per HTTP request/cron invocation |
| D1 Free daily rows read | 5 million |
| D1 Free daily rows written | 100,000 |
| D1 Free database size | 500 MB per database; 5 GB across the account |
| D1 Free queries | 50 per Worker invocation |
| R2 Standard included storage/operations | 10 GB-month; 1 million Class A and 10 million Class B operations monthly |

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

The tested database is below the conservative 500 MB per-database reference, but the extra stress fixture approaches it. Registration history, active traffic, media and other applications sharing the account consume separate quotas. Local wall-clock measurements do not verify the Workers CPU limit. Monitor the actual account's daily request/row metrics and stored bytes; keep retention, attachment quotas and bounded background work active. This result supports a large registered population with fewer active customers while traffic and storage remain within those limits. It does not establish unlimited use at no cost.

## Reproduce locally

From the app directory, install its pinned development dependencies using Node 24.15 or newer, then run:

```sh
npm ci
node scripts/benchmark-capacity.mjs
```

The portable harness creates and disposes an ephemeral Miniflare database, uses synthetic profiles and credentials, and calls only its in-process localhost Worker. It requires no Cloudflare credentials and has no production-target option. It writes `build/capacity-report.json`. A smaller smoke fixture is available with `--profiles=1000 --output=build/capacity-smoke.json`. Seeding statements intentionally bypass production traffic and write quotas; never use this harness as a production import procedure.

This report covers the completed run above. Source hashes in the JSON identify the tested runtime snapshot and have been preserved. After that snapshot, the backend batched owner media/library grants (up to 20 items) and customer attachment lookups (up to 10), kept the retention marker until expired auxiliary backlogs drain, and replaced the redundant prefix `LIKE` predicate with literal `substr` equality while retaining the indexed lower/upper range. The latter avoids D1's documented 50-byte `LIKE`/`GLOB` pattern limit for long names. These follow-up changes are outside the volume measurements above; their focused regressions, main suite and final browser verification must be assessed separately.
