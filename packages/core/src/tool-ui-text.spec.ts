import { expect, it } from 'vitest';
import { escapeUnsafeToolUiText } from './tool-ui.js';
it('preserves readable text and paired Unicode while escaping native TEXT-invalid code units', () => {
  expect(escapeUnsafeToolUiText('Readable 😀\ntext')).toBe('Readable 😀\ntext');
  expect(escapeUnsafeToolUiText('nul\u0000 high\ud800 low\udfff')).toBe(
    'nul\\u0000 high\\ud800 low\\udfff',
  );
});
