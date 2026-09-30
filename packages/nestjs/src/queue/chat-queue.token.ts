/**
 * The thread message queue, as the durable runner and the `agent.run` workflow ask for it.
 *
 * A token rather than the `ChatQueueService` class: `@dudousxd/nestjs-agent/durable` is a separate
 * bundle with its own copy of every class it imports, so a class used as an injection token there
 * is not the class `AgentModule` provides. `Symbol.for` is the same value in every bundle.
 */
export const AGENT_CHAT_QUEUE = Symbol.for('@dudousxd/nestjs-agent:chat-queue');
