// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type ChatMode, ChatModePills } from './chat-mode-pills';

const modes: ChatMode[] = [
  { id: 'digest', label: 'Digest' },
  { id: 'draft', label: 'Draft' },
  { id: 'audit', label: 'Audit', disabled: true },
];

describe('ChatModePills', () => {
  it('reports the mode that was picked', () => {
    const onSelect = vi.fn();
    render(<ChatModePills modes={modes} value="digest" onSelect={onSelect} />);

    fireEvent.click(screen.getByText('Draft'));

    expect(onSelect).toHaveBeenCalledWith({ id: 'draft', label: 'Draft' });
  });

  it('marks only the selected mode as pressed', () => {
    render(<ChatModePills modes={modes} value="digest" />);
    expect(screen.getByText('Digest').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Draft').getAttribute('aria-pressed')).toBe('false');
  });

  it('treats no mode as a legitimate state', () => {
    render(<ChatModePills modes={modes} value={null} />);
    for (const mode of modes) {
      expect(screen.getByText(mode.label).getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('does not report a mode the host disabled', () => {
    const onSelect = vi.fn();
    render(<ChatModePills modes={modes} onSelect={onSelect} />);

    fireEvent.click(screen.getByText('Audit'));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('names the group for a screen reader', () => {
    render(<ChatModePills modes={modes} label="How to answer" />);
    expect(screen.getByRole('group', { name: 'How to answer' })).toBeTruthy();
  });
});
