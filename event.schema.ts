import * as Schema from 'effect/Schema'

/** Dot-separated identities for event contracts and listener diagnostics, such as moments.post-created. */
export const eventNameSchema = Schema.TemplateLiteral([Schema.String, '.', Schema.String])
export type EventName = Schema.Schema.Type<typeof eventNameSchema>

/** Identifies the participant responsible for a typed publication failure while preserving its original cause. */
export class EventListenerError extends Schema.TaggedError<EventListenerError>()('EventListenerError', {
  event: eventNameSchema,
  listener: eventNameSchema,
  cause: Schema.Defect(),
}) {}
