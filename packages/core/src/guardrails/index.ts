/**
 * `@dudousxd/nestjs-agent-core/guardrails` — PII, secret, prompt-injection and tool-poisoning
 * detection, a rule engine with reversible redaction, a provider-stream guard, and the adapter onto
 * the agent loop's processor seams.
 *
 * Everything but `Guardrails` is standalone: no NestJS, no agent loop, no Node-only API. A gateway
 * that proxies raw OpenAI / Anthropic / MCP traffic uses `scan`, `Vault`, `StreamGuard` and the
 * `*Slots` helpers directly.
 */

export {
  ACTION_SEVERITY,
  GUARDRAIL_STAGES,
  PII_TYPES,
  SECRET_TYPES,
  type CustomDetector,
  type DetectorKind,
  type DetectorSpec,
  type Finding,
  type GuardContext,
  type GuardrailAction,
  type GuardrailMatch,
  type GuardrailOptions,
  type GuardrailRule,
  type GuardrailStage,
  type PiiType,
  type SecretType,
  type Segment,
  type SegmentSource,
} from './types.js';
export {
  cardBrand,
  cnpjValid,
  cpfValid,
  detectPii,
  ibanValid,
  isIPv4,
  luhnValid,
  phoneValid,
  ssnValid,
} from './detectors/pii.js';
export { detectSecrets, entropy } from './detectors/secrets.js';
export {
  INJECTION_SIGNALS,
  decodeTagChars,
  scoreInjection,
  type InjectionResult,
  type Signal,
} from './detectors/injection.js';
export {
  scoreToolText,
  toolText,
  type PoisoningResult,
  type ToolDefinitionText,
} from './detectors/tool-poisoning.js';
export { compileGuardPattern, detectKeywords, detectRegex, fold } from './detectors/custom.js';
export { globToRegExp, matchesAny } from './glob.js';
export { Vault, labelFor, type VaultSnapshot } from './vault.js';
export {
  DEFAULT_APPROVAL_MESSAGE,
  DEFAULT_MESSAGES,
  INJECTION_REPLACEMENT,
  applyRedactions,
  orderRules,
  resolveOverlaps,
  ruleApplies,
  runDetector,
  scan,
  spanLocator,
  type GuardHit,
  type ScanOptions,
  type ScanResult,
} from './engine.js';
export {
  jsonSlots,
  refuseResponse,
  requestSlots,
  responseSlots,
  toolResultSlots,
  type Slot,
} from './segments.js';
export { StreamGuard, type StreamGuardOptions, type WindowVerdict } from './stream-guard.js';
export {
  GuardrailBlockedError,
  Guardrails,
  InMemoryVaultStore,
  createGuardrails,
  screenToolDefinition,
  shorthandRules,
  type AgentGuardContext,
  type GuardrailEvent,
  type GuardrailEventHit,
  type GuardrailRulesSource,
  type GuardrailsOptions,
  type InjectionShorthand,
  type PiiShorthand,
  type SecretsShorthand,
  type ToolPoisoningShorthand,
  type VaultStore,
} from './agent.js';
