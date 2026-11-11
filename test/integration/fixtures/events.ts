import { createEventSystem } from '../../../src/index.js'
import { Database, Transaction } from './database.js'

export const { defineEvent, defineListener } = createEventSystem({ database: Database, transaction: Transaction })
export type { DomainEvent, TransactionalListenerDefinition, EventListenerError } from '../../../src/index.js'
