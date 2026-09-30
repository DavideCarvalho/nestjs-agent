import { type WorkflowCtx, runInWorkflowCtx } from '@dudousxd/nestjs-durable-core';

/**
 * Run `fn` outside the ambient workflow ctx.
 *
 * The runtime keeps the running workflow's ctx in an `AsyncLocalStorage` for the whole turn, and a
 * class-first static reads it to route: inside a workflow, `SomeWorkflow.start(...)` becomes
 * `ctx.startChild` and `SomeWorkflow.execute(...)` becomes `ctx.child` — each of which takes a
 * POSITION in the journal. That is right in a workflow body and wrong in a step body, and a step
 * body is where everything the application wrote runs: a tool's `execute`, a processor, a store. A
 * tool that starts a workflow of the app's own (directly, or through a service three calls down)
 * would record `spawn:<id>` in the AGENT run's journal at the position after its own step, from
 * inside that step. The first attempt then writes `persist:toolexec:<callId>` one position further
 * on; a replay skips the completed step's body, never asks for the spawn's position, and offers it
 * to `persist:toolexec:<callId>` instead — which the runtime refuses as non-determinism, failing a
 * run nothing had changed under. It only takes a resume after such a tool to get there: a second
 * action awaiting approval in the same step, or an approval in any later one.
 *
 * It reaches a DISPATCHED step too: a transport that delivers in-process (the event-emitter one)
 * invokes the handler on the body's own async path, ambient ctx and all.
 *
 * Outside the ambient ctx those statics go to the engine, as they do from a controller: the started
 * run is a run of its own, and the step's recorded result keeps a replay from starting it twice.
 */
export function outsideWorkflowCtx<T>(fn: () => T): T {
  // `undefined` is what the storage holds outside any workflow; the runtime exposes no `exit`.
  return runInWorkflowCtx(undefined as unknown as WorkflowCtx, fn);
}

/**
 * `ctx.localStep` bound to `ctx`, with every body run {@link outsideWorkflowCtx}. The position is
 * still taken on the call, before the first await.
 */
export function stepOf(ctx: WorkflowCtx): WorkflowCtx['localStep'] {
  return ((name: string, fn: (...args: unknown[]) => unknown, ...rest: unknown[]) =>
    (ctx.localStep as (...all: unknown[]) => unknown)(
      name,
      (...args: unknown[]) => outsideWorkflowCtx(() => fn(...args)),
      ...rest,
    )) as WorkflowCtx['localStep'];
}
