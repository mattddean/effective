import { PgClient } from '@effect/sql-pg'
import { beforeAll, describe, expect, test } from 'bun:test'
import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import { SchemaBinary } from 'effect/encoding'
import { EventJournal } from 'effect/eventlog'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import { WorkflowEngine } from 'effect/workflow'

import type { clusterMessages } from '~/framework/workflow-storage.schema'

import { defineEvent, defineListener } from '~/framework/event.logic'
import { defineModule } from '~/framework/module.logic'
import { workflowConsumerTestLayer } from '~/framework/test/workflow-consumer-test.workflow'
import { SharedConsumerTestWorkflow } from '~/framework/test/workflow-consumer-test.workflow-contract'
import { withShoppingTransaction } from '~/infrastructure/transaction.operation'
import { testRuntime } from '~/test/runtime/root.runtime'
import { workflowTestNodeLayer } from '~/workflows/workflow-test.layer'

type ConsumerInput = typeof SharedConsumerTestWorkflow.payloadSchema.Type
type CaseId = ConsumerInput['caseId']
const ConsumerFact = defineEvent('effective.test-workflow-consumers', {
  payload: Schema.Struct({ caseId: Schema.String.check(Schema.isUUID()), failFirst: Schema.Boolean }),
  concurrency: 1,
})
const eventCodec = SchemaBinary.toCodec(ConsumerFact.payload)
const eventName = 'effective.test-workflow-consumers'
const consumers = ['first', 'second'] as const

beforeAll(async () => {
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const client = yield* PgClient.PgClient
      yield* client`CREATE TABLE effective_test_workflow_publications (id UUID PRIMARY KEY)`
      yield* client`CREATE TABLE effective_test_workflow_consumers (
      case_id UUID NOT NULL, event_id TEXT NOT NULL, consumer TEXT NOT NULL,
      calls INTEGER NOT NULL, finished BOOLEAN NOT NULL DEFAULT FALSE, waiting BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (event_id, consumer)
    )`
    }),
  )
})

const starts = Effect.fn('WorkflowListenerTest.starts')(function* (caseId: CaseId) {
  const client = yield* PgClient.PgClient
  return yield* client<{
    entity_id: Effect.Success<ReturnType<typeof SharedConsumerTestWorkflow.executionId>>
    payload: NonNullable<typeof clusterMessages.$inferSelect.payload>
    processed: boolean
  }>`
    SELECT entity_id, processed, payload FROM cluster_messages
    WHERE tag = 'run' AND entity_type = 'Workflow/effective-test-shared-consumer' AND payload LIKE ${`%${caseId}%`}
    ORDER BY entity_id
  `
})

const completedStarts = Effect.fn('WorkflowListenerTest.completedStarts')((caseId: CaseId) =>
  starts(caseId).pipe(
    Effect.repeat({
      while: (jobs) => jobs.length === 0 || jobs.some((job) => !job.processed),
      schedule: Schedule.spaced('10 millis'),
    }),
    Effect.timeout('3 seconds'),
  ),
)

const results = Effect.fn('WorkflowListenerTest.results')(function* (caseId: CaseId) {
  const client = yield* PgClient.PgClient
  return yield* client<{ consumer: ConsumerInput['consumer']; calls: number; finished: boolean; waiting: boolean }>`
    SELECT consumer, calls, finished, waiting FROM effective_test_workflow_consumers
    WHERE case_id = ${caseId} ORDER BY consumer, event_id
  `
})

const records = Effect.fn('WorkflowListenerTest.records')(function* (caseId: CaseId) {
  const journal = yield* EventJournal.EventJournal
  const decoded = yield* Effect.forEach(
    (yield* journal.entries).filter((entry) => entry.event === eventName),
    (entry) =>
      Schema.decodeEffect(eventCodec)(new Uint8Array(entry.payload)).pipe(
        Effect.map((payload) => ({ entry, payload })),
      ),
  )
  return decoded.filter(({ payload }) => payload.caseId === caseId)
})

const publisherContext = Effect.fn('WorkflowListenerTest.publisherContext')(function* () {
  const node = yield* Layer.build(workflowTestNodeLayer({ group: 'local', worker: false }))
  const subscriptions = consumers.map((consumer) =>
    defineListener(ConsumerFact, {
      name: `effective.${consumer}`,
      processing: 'workflow',
      workflow: SharedConsumerTestWorkflow,
      mapPayload: (payload) => ({ caseId: payload.caseId, consumer, fail: consumer === 'first' && payload.failFirst }),
    }),
  )
  return yield* Layer.build(
    defineModule({ imports: [], internal: [], exports: [], listeners: subscriptions }).pipe(
      Layer.provideMerge(Layer.fresh(ConsumerFact.layer)),
      Layer.provide(Layer.succeedContext(node)),
    ),
  )
})

const publish = Effect.fn('WorkflowListenerTest.publish')(function* (options: {
  context: Effect.Success<ReturnType<typeof publisherContext>>
  caseId: CaseId
  failFirst?: boolean
}) {
  yield* ConsumerFact.publish({ caseId: options.caseId, failFirst: options.failFirst ?? false }).pipe(
    Effect.provide(options.context),
  )
})

const startWorker = Effect.fn('WorkflowListenerTest.startWorker')(function* () {
  const worker = yield* Layer.build(workflowTestNodeLayer({ group: 'local', worker: true }))
  yield* Layer.build(workflowConsumerTestLayer('recover').pipe(Layer.provide(Layer.succeedContext(worker))))
  return Context.get(worker, WorkflowEngine.WorkflowEngine)
})

const childWorker = Effect.fn('WorkflowListenerTest.childWorker')((mode: 'crash' | 'recover') =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Bun.spawn([process.execPath, `${import.meta.dir}/test/workflow-consumer-test.runtime.ts`, mode], {
        env: process.env,
        stdout: 'ignore',
        stderr: 'inherit',
      }),
    ),
    (worker) => Effect.sync(() => worker.kill('SIGKILL')).pipe(Effect.andThen(Effect.promise(() => worker.exited))),
  ),
)

describe('Effective product requirements for workflow-reference listeners: independent delivery identities', () => {
  test('two consumers of the same workflow remain independent despite its constant idempotency key', async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const caseId = crypto.randomUUID()
        const context = yield* publisherContext()
        yield* withShoppingTransaction(publish({ context, caseId }))
        const first = { caseId, consumer: 'first' as const, fail: false }
        const second = { ...first, consumer: 'second' as const }
        expect(yield* SharedConsumerTestWorkflow.executionId(first)).toBe(
          yield* SharedConsumerTestWorkflow.executionId(second),
        )
        const pending = yield* starts(caseId)
        expect(pending).toHaveLength(2)
        expect(new Set(pending.map((job) => job.entity_id)).size).toBe(2)
        expect(yield* results(caseId)).toHaveLength(0)
        yield* startWorker()
        yield* completedStarts(caseId)
        expect(yield* results(caseId)).toMatchObject([
          { consumer: 'first', calls: 1, finished: true },
          { consumer: 'second', calls: 1, finished: true },
        ])
      }).pipe(Effect.scoped, Effect.timeout('5 seconds')),
    )
  })

  test('identical payloads in two journal events produce four independent consumer executions', async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const caseId = crypto.randomUUID()
        const context = yield* publisherContext()
        yield* withShoppingTransaction(publish({ context, caseId }))
        yield* withShoppingTransaction(publish({ context, caseId }))
        expect(yield* records(caseId)).toHaveLength(2)
        const jobs = yield* starts(caseId)
        expect(jobs).toHaveLength(4)
        expect(new Set(jobs.map((job) => job.entity_id)).size).toBe(4)
        yield* startWorker()
        yield* completedStarts(caseId)
        expect(yield* results(caseId)).toHaveLength(4)
        expect((yield* results(caseId)).every((row) => row.calls === 1 && row.finished)).toBe(true)
      }).pipe(Effect.scoped, Effect.timeout('5 seconds')),
    )
  })

  test('a failing consumer cannot undo publication or prevent its sibling from completing', async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const caseId = crypto.randomUUID()
        const context = yield* publisherContext()
        yield* withShoppingTransaction(publish({ context, caseId, failFirst: true }))
        const worker = yield* startWorker()
        yield* completedStarts(caseId)
        const pending = yield* starts(caseId)
        const first = pending.find((job) => job.payload.includes('"first"'))
        const second = pending.find((job) => job.payload.includes('"second"'))
        if (!first || !second) return yield* Effect.die('Both workflow consumers must be persisted')
        const failed = yield* worker.poll(SharedConsumerTestWorkflow, first.entity_id)
        const succeeded = yield* worker.poll(SharedConsumerTestWorkflow, second.entity_id)
        expect(Option.isSome(failed) && failed.value._tag === 'Complete' && Exit.isFailure(failed.value.exit)).toBe(
          true,
        )
        expect(
          Option.isSome(succeeded) && succeeded.value._tag === 'Complete' && Exit.isSuccess(succeeded.value.exit),
        ).toBe(true)
        expect(yield* records(caseId)).toHaveLength(1)
        expect(yield* results(caseId)).toMatchObject([
          { consumer: 'first', calls: 1, finished: false },
          { consumer: 'second', calls: 1, finished: true },
        ])
      }).pipe(Effect.scoped, Effect.timeout('5 seconds')),
    )
  })

  test('rejecting the second consumer start rolls back the journal, first start, and domain mutation together', async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const client = yield* PgClient.PgClient
        const caseId = crypto.randomUUID()
        const context = yield* publisherContext()
        const outcome = yield* withShoppingTransaction(
          Effect.gen(function* () {
            yield* client`ALTER TABLE cluster_messages ADD CONSTRAINT reject_second_consumer
          CHECK (entity_type <> 'Workflow/effective-test-shared-consumer' OR payload NOT LIKE '%"second"%') NOT VALID`
            yield* client`INSERT INTO effective_test_workflow_publications (id) VALUES (${caseId})`
            yield* publish({ context, caseId })
          }),
        ).pipe(Effect.exit)
        expect(Exit.isFailure(outcome)).toBe(true)
        if (Exit.isFailure(outcome)) expect(Cause.pretty(outcome.cause)).toContain('reject_second_consumer')
        expect(yield* client`SELECT id FROM effective_test_workflow_publications WHERE id = ${caseId}`).toHaveLength(0)
        expect(yield* records(caseId)).toHaveLength(0)
        expect(yield* starts(caseId)).toHaveLength(0)
        yield* startWorker()
        yield* Effect.sleep('50 millis')
        expect(yield* results(caseId)).toHaveLength(0)
      }).pipe(Effect.scoped, Effect.timeout('5 seconds')),
    )
  })

  test('SIGKILL preserves independent consumer progress and recovery does not repeat completed activities', async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const caseId = crypto.randomUUID()
        const context = yield* publisherContext()
        yield* withShoppingTransaction(publish({ context, caseId }))
        const original = yield* starts(caseId)
        const worker = yield* childWorker('crash')
        const paused = yield* results(caseId).pipe(
          Effect.repeat({
            while: (rows) =>
              !rows.some((row) => row.consumer === 'first' && row.finished) ||
              !rows.some((row) => row.consumer === 'second' && row.waiting),
            schedule: Schedule.spaced('10 millis'),
          }),
        )
        expect(paused.map((row) => row.calls)).toEqual([1, 1])
        yield* starts(caseId).pipe(
          Effect.repeat({
            while: (jobs) => !jobs.some((job) => job.payload.includes('"first"') && job.processed),
            schedule: Schedule.spaced('10 millis'),
          }),
        )
        worker.kill('SIGKILL')
        yield* Effect.promise(() => worker.exited)
        expect(worker.signalCode).toBe('SIGKILL')
        expect((yield* starts(caseId)).filter((job) => job.processed)).toHaveLength(1)
        yield* childWorker('recover')
        const completed = yield* completedStarts(caseId)
        expect(completed.map((job) => job.entity_id)).toEqual(original.map((job) => job.entity_id))
        expect(yield* results(caseId)).toMatchObject([
          { consumer: 'first', calls: 1, finished: true },
          { consumer: 'second', calls: 1, finished: true },
        ])
      }).pipe(Effect.scoped, Effect.timeout('10 seconds')),
    )
  }, 15000)
})
