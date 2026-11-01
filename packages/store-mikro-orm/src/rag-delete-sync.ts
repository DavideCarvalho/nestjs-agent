import {
  EntityManager,
  type EntityName,
  type EventSubscriber,
  type FlushEventArgs,
  type TransactionEventArgs,
} from '@mikro-orm/core';
import { Logger } from '@nestjs/common';

/**
 * What the sync needs of a `RagRepository`. Structural, so this package needs no dependency on
 * `@dudousxd/nestjs-agent-rag`.
 */
export interface RagDeleteTarget<Row> {
  id(row: Row): string | number;
  remove(id: string | number): Promise<void>;
}

/**
 * Removes a row's chunks once its deletion has committed. It collects ids at flush and acts after the
 * commit, never in `afterDelete`, which fires before a rollback and would drop the chunks of a row
 * that still exists. A removal that fails is logged, not thrown: the row is already gone, and failing
 * the caller's `flush` wouldn't bring it back. `reconcile` repairs it.
 *
 * It only sees `em.remove`. `nativeDelete`, query builders, raw SQL and `ON DELETE CASCADE` fire
 * nothing, so run `reconcile` on a schedule if any of them can delete these rows. MikroORM 6 fires no
 * transaction event for a nested transaction, so a delete flushed inside one isn't removed there:
 * the chunks stay until `reconcile`. They are never removed wrongly.
 */
export class RagDeleteSubscriber<Row extends object> implements EventSubscriber<Row> {
  private readonly logger = new Logger(RagDeleteSubscriber.name);
  /**
   * Ids waiting on a commit, by transaction. Keyed by transaction rather than by a field on this
   * singleton, so concurrent requests don't see each other's. A flush outside a transaction has no
   * context yet, so it is keyed by its EntityManager until the implicit transaction commits.
   */
  private readonly pending = new WeakMap<object, (string | number)[]>();
  /** A savepoint's enclosing transaction. Releasing a savepoint isn't a commit. */
  private readonly parents = new WeakMap<object, object>();
  private readonly starting = new WeakMap<object, object>();

  constructor(
    private readonly entity: new (...args: never[]) => Row,
    private readonly target: RagDeleteTarget<Row>,
  ) {}

  getSubscribedEntities(): EntityName<Row>[] {
    return [this.entity];
  }

  onFlush(args: FlushEventArgs): void {
    const ids = args.uow
      .getChangeSets()
      .filter(
        (changeSet) =>
          changeSet.type === 'delete' && (changeSet.meta.class as unknown) === this.entity,
      )
      .map((changeSet) => this.target.id(changeSet.entity as Row));
    if (ids.length > 0) {
      this.add(args.em.getTransactionContext() ?? args.em, ids);
    }
  }

  // MikroORM reports a nested begin in two steps: before it with the parent, after it with the savepoint.
  beforeTransactionStart(args: TransactionEventArgs): void {
    if (args.transaction) {
      this.starting.set(args.em, args.transaction as object);
    }
  }

  afterTransactionStart(args: TransactionEventArgs): void {
    const parent = this.starting.get(args.em);
    this.starting.delete(args.em);
    if (parent !== undefined && args.transaction) {
      this.parents.set(args.transaction as object, parent);
    }
  }

  async afterTransactionCommit(args: TransactionEventArgs): Promise<void> {
    const ids = this.take(args);
    const parent = args.transaction ? this.parents.get(args.transaction as object) : undefined;
    if (parent !== undefined) {
      this.add(parent, ids);
      return;
    }
    const results = await Promise.allSettled(ids.map((id) => this.target.remove(id)));
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        this.logger.error(
          `Could not remove the RAG chunks of ${String(ids[index])}; reconcile will repair it: ${String(result.reason)}`,
        );
      }
    }
  }

  afterTransactionRollback(args: TransactionEventArgs): void {
    this.take(args);
  }

  private add(key: object, ids: (string | number)[]): void {
    if (ids.length > 0) {
      this.pending.set(key, [...(this.pending.get(key) ?? []), ...ids]);
    }
  }

  private take(args: TransactionEventArgs): (string | number)[] {
    const keys = [args.transaction as object | undefined, args.em];
    return keys.flatMap((key) => {
      if (key === undefined) {
        return [];
      }
      const ids = this.pending.get(key) ?? [];
      this.pending.delete(key);
      return ids;
    });
  }
}

/**
 * A provider registering a {@link RagDeleteSubscriber} once Nest has built the repository:
 *
 * ```ts
 * providers: [DocumentsRag, provideRagDeleteSync(ProjectDocument, DocumentsRag)]
 * ```
 */
export function provideRagDeleteSync<Row extends object>(
  entity: new (...args: never[]) => Row,
  repository: abstract new (...args: never[]) => RagDeleteTarget<Row>,
) {
  return {
    provide: Symbol('nestjs-agent:rag-delete-sync'),
    inject: [EntityManager, repository],
    useFactory: (em: EntityManager, target: RagDeleteTarget<Row>) => {
      const subscriber = new RagDeleteSubscriber(entity, target);
      em.getEventManager().registerSubscriber(subscriber);
      return subscriber;
    },
  };
}
