import { describe, expect, it } from 'vitest';
import { formatModelLabel } from './format-model';

describe('formatModelLabel', () => {
  it('shortens a Bedrock inference-profile ARN to the model name', () => {
    expect(
      formatModelLabel(
        'arn:aws-us-gov:bedrock:us-gov-west-1:358252705848:inference-profile/us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0',
      ),
    ).toBe('claude-sonnet-4-5-20250929-v1:0');
  });

  it('drops the region + provider from a commercial inference-profile id', () => {
    expect(
      formatModelLabel(
        'arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0',
      ),
    ).toBe('claude-3-5-sonnet-20241022-v2:0');
  });

  it('passes plain (non-ARN) model ids through unchanged', () => {
    expect(formatModelLabel('gpt-4o')).toBe('gpt-4o');
    expect(formatModelLabel('claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
  });
});
