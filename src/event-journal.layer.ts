import { SqlEventJournal } from 'effect/eventlog'

// Effect owns table creation; the Drizzle schema is a read model for this storage.
export const EventJournalLive = SqlEventJournal.layer()
