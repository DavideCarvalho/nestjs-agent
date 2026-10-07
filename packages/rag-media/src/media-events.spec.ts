import { describe, expect, it } from 'vitest';
import { isMediaDeleteEvent } from './media-events.js';

describe('isMediaDeleteEvent', () => {
  it('accepts the full delete payload', () => {
    expect(isMediaDeleteEvent({ id: 'm1', ownerType: 'Post', ownerId: '7' })).toBe(true);
  });

  it('refuses a payload missing the owner the MediaDeleteEvent type promises', () => {
    expect(isMediaDeleteEvent({ id: 'm1' })).toBe(false);
    expect(isMediaDeleteEvent({ id: 'm1', ownerType: 'Post' })).toBe(false);
    expect(isMediaDeleteEvent({ id: 'm1', ownerType: '', ownerId: '7' })).toBe(false);
  });
});
