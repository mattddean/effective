import { Digest } from 'effect/crypto'
import { BunServices } from '@effect/platform-bun'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { EventJournalLive } from '../../../src/index.js'
import { TestDatabaseLive, TestPgClientLive, WorkflowSqlTestStorageLive } from './database.js'

export const testRuntime = ManagedRuntime.make(Layer.mergeAll(
  TestDatabaseLive,
  WorkflowSqlTestStorageLive,
  EventJournalLive.pipe(Layer.provide(TestPgClientLive)),
  BunServices.layer,
).pipe(Layer.provide(Digest.layerWebCrypto)))
