import { describe, expect, it } from 'vitest';
import { isControlFlowSignal } from './control-flow.js';

/**
 * A suspend as it reaches core: a class from a package core cannot import, carrying only the
 * global-registry marker both sides declare. Built with `Object.assign` because a computed class
 * member needs a `unique symbol`, which `Symbol.for` deliberately isn't — the whole point is that
 * every declaration of this key is the same symbol.
 */
function markedSignal(name: string): Error {
  const signal = new Error('workflow suspended');
  signal.name = name;
  return Object.assign(signal, { [Symbol.for('aviary:durable:control-flow')]: true });
}

describe('isControlFlowSignal', () => {
  it('recognizes a signal marked by a SEPARATELY declared Symbol.for of the same key', () => {
    expect(isControlFlowSignal(markedSignal('WorkflowSuspended'))).toBe(true);
    expect(isControlFlowSignal(markedSignal('ContinueAsNew'))).toBe(true);
    expect(isControlFlowSignal(markedSignal('Suspend'))).toBe(true);
  });

  it('is false for a real failure, including one that merely looks like a signal', () => {
    expect(isControlFlowSignal(new Error('boom'))).toBe(false);
    expect(
      isControlFlowSignal(Object.assign(new Error('boom'), { name: 'WorkflowSuspended' })),
    ).toBe(false);
    // A plain `Symbol()` of the same description is a DIFFERENT symbol — the global registry is what
    // makes the marker portable, so an unregistered lookalike must not pass.
    expect(
      isControlFlowSignal(
        Object.assign(new Error('boom'), { [Symbol('aviary:durable:control-flow')]: true }),
      ),
    ).toBe(false);
  });

  it('is false for non-objects and for a marker that is not `true`', () => {
    expect(isControlFlowSignal(undefined)).toBe(false);
    expect(isControlFlowSignal(null)).toBe(false);
    expect(isControlFlowSignal('workflow suspended')).toBe(false);
    expect(
      isControlFlowSignal({ [Symbol.for('aviary:durable:control-flow')]: 'yes' as unknown }),
    ).toBe(false);
  });
});
