import type { MessageStorage, RunnerStorage } from 'effect/cluster'
import { WorkflowEngine } from 'effect/workflow'

import * as Effect from 'effect/Effect'
import {
  ClusterSchema, ClusterWorkflowEngine, RunnerAddress, RunnerHealth, Runners, Sharding, ShardingConfig,
} from 'effect/cluster'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'

const WORKFLOW_SHARD_GROUPS = ['default', 'local']

export function workflowTestNodeLayer(options: {
  group: 'default' | 'local'
  worker: boolean
}): Layer.Layer<
  WorkflowEngine.WorkflowEngine | Sharding.Sharding,
  never,
  MessageStorage.MessageStorage | RunnerStorage.RunnerStorage
> {
  const clusterLayer = Sharding.layer.pipe(
    Layer.provide(Runners.layerNoop),
    Layer.provide(RunnerHealth.layerNoop),
    Layer.provide(
      ShardingConfig.layer({
        runnerAddress: options.worker
          ? Option.some(RunnerAddress.make(`test-worker-${options.group}`, 34431))
          : Option.none(),
        availableShardGroups: WORKFLOW_SHARD_GROUPS,
        assignedShardGroups: [options.group],
        shardsPerGroup: 1,
        entityMessagePollInterval: '10 millis',
        entityReplyPollInterval: '10 millis',
        refreshAssignmentsInterval: '10 millis',
      }),
    ),
  )
  // Expose the original Sharding to callers, as the app does for cron registration.
  // Each test node needs its own Sharding instance; v4 otherwise shares layers across builds.
  return workflowEngineLayer(options.group).pipe(Layer.provideMerge(clusterLayer), Layer.fresh)
}

export function workflowEngineLayer(
  shardGroup: 'default' | 'local',
): Layer.Layer<WorkflowEngine.WorkflowEngine, never, Sharding.Sharding | MessageStorage.MessageStorage> {
  // Scope routing to the workflow engine, including its durable timers. Cron keeps the original Sharding service.
  const routingLayer = Layer.effect(
    Sharding.Sharding,
    Effect.gen(function* () {
      const sharding = yield* Sharding.Sharding
      return Sharding.Sharding.of({
        ...sharding,
        getShardId: (entityId) => sharding.getShardId(entityId, shardGroup),
        makeClient: Effect.fn('WorkflowRouting.makeClient')((entity) =>
          sharding.makeClient(entity.annotate(ClusterSchema.ShardGroup, () => shardGroup)),
        ),
        registerEntity: Effect.fn('WorkflowRouting.registerEntity')((entity, handlers, options) =>
          sharding.registerEntity(
            entity.annotate(ClusterSchema.ShardGroup, () => shardGroup),
            handlers,
            options,
          ),
        ),
      })
    }),
  )
  const engineLayer = ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(routingLayer))

  return Layer.effect(
    WorkflowEngine.WorkflowEngine,
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine
      const sharding = yield* Sharding.Sharding
      // Cached clients merge the caller's context; keep an outer, unconfigured Sharding from replacing our routing.
      const withRouting = Effect.provideService(Sharding.Sharding, sharding)
      return WorkflowEngine.WorkflowEngine.of({
        register: Effect.fn('WorkflowRouting.register')((workflow, execute) =>
          engine.register(workflow, execute).pipe(withRouting),
        ),
        execute: Effect.fn('WorkflowRouting.execute')((workflow, options) =>
          engine.execute(workflow, options).pipe(withRouting),
        ),
        poll: Effect.fn('WorkflowRouting.poll')((workflow, executionId) =>
          engine.poll(workflow, executionId).pipe(withRouting),
        ),
        interrupt: Effect.fn('WorkflowRouting.interrupt')((workflow, executionId) =>
          engine.interrupt(workflow, executionId).pipe(withRouting),
        ),
        interruptUnsafe: Effect.fn('WorkflowRouting.interruptUnsafe')((workflow, executionId) =>
          engine.interruptUnsafe(workflow, executionId).pipe(withRouting),
        ),
        resume: Effect.fn('WorkflowRouting.resume')((workflow, executionId) =>
          engine.resume(workflow, executionId).pipe(withRouting),
        ),
        activityExecute: Effect.fn('WorkflowRouting.activityExecute')((activity, attempt) =>
          engine.activityExecute(activity, attempt).pipe(withRouting),
        ),
        deferredResult: Effect.fn('WorkflowRouting.deferredResult')((deferred) =>
          engine.deferredResult(deferred).pipe(withRouting),
        ),
        deferredDone: Effect.fn('WorkflowRouting.deferredDone')((deferred, options) =>
          engine.deferredDone(deferred, options).pipe(withRouting),
        ),
        scheduleClock: Effect.fn('WorkflowRouting.scheduleClock')((workflow, options) =>
          engine.scheduleClock(workflow, options).pipe(withRouting),
        ),
      })
    }),
  ).pipe(Layer.provide(engineLayer))
}
