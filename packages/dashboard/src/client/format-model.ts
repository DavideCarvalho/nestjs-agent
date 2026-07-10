/**
 * Turn a raw model id — often a full Bedrock inference-profile ARN — into a short, readable label
 * for the governance UI. Bedrock ids arrive as
 * `arn:aws:bedrock:<region>:<acct>:inference-profile/<region>.<provider>.<model>`, which overflows
 * cards and shoves table columns sideways. We keep the distinguishing `<model>` and drop the ARN
 * prefix plus the cross-region/provider qualifiers. Non-ARN ids (e.g. `gpt-4o`) pass through
 * unchanged. The full id is still surfaced via a `title` tooltip at the call sites.
 */
export function formatModelLabel(modelId: string): string {
  if (!modelId.includes('/')) {
    return modelId;
  }
  const profile = modelId.slice(modelId.lastIndexOf('/') + 1);
  // Inference-profile ids are "<region>.<provider>.<model>" (e.g. "us-gov.anthropic.claude-…").
  // Drop the leading region + provider so only the model name remains.
  return profile.replace(/^[a-z]{2}[a-z-]*\.[a-z0-9]+\./, '');
}
