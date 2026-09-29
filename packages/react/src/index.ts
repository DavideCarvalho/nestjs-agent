export {
  AgentChatTransport,
  type AgentChatTransportOptions,
  type AgentStreamMeta,
  type ReconnectOptions,
  type StreamConnectionState,
} from './agent-chat-transport.js';
export {
  acceptsFile,
  dragHasFiles,
  fileKind,
  filesFromClipboard,
  type MessageFile,
  type MessageFileKind,
  messageFiles,
} from './attachments/files.js';
export {
  type AttachmentRejection,
  type AttachmentsState,
  type ClipboardLikeEvent,
  type DragLikeEvent,
  type StagedAttachment,
  type StagedAttachmentStatus,
  useAttachments,
  type UseAttachmentsOptions,
} from './attachments/use-attachments.js';
export {
  type AgentBackend,
  AgentBackendUnsupportedError,
  type ChatStreamRequest,
  type ChatStreamResponse,
  type MessageFeedbackInput,
  requireBackendMethod,
  type ResumeStreamRequest,
  type UploadAttachmentOptions,
} from './backend.js';
export { type AgentsState, useAgents, type UseAgentsOptions } from './catalog/use-agents.js';
export {
  type ModelOption,
  type ModelsState,
  useModels,
  type UseModelsOptions,
} from './catalog/use-models.js';
export { type QuotaState, useQuota, type UseQuotaOptions } from './quota/use-quota.js';
export {
  type MessageFeedbackState,
  useMessageFeedback,
  type UseMessageFeedbackOptions,
} from './feedback/use-message-feedback.js';
export {
  notifyThreads,
  onThreadsEvent,
  type ThreadsEvent,
} from './threads/threads-events.js';
export { type ThreadsState, useThreads, type UseThreadsOptions } from './threads/use-threads.js';
export { type BackgroundRun, backgroundRunsFromThread } from './background-runs.js';
export {
  AgentClient,
  type AgentClientOptions,
  AgentHttpError,
  type CancelResult,
  type QuotaToday,
  type ThreadPatch,
} from './client.js';
// Named, never `export *`: a wildcard re-export from a barrel defeats a bundler's ability to see
// which names a consumer actually uses, and has broken a downstream build in this ecosystem before.
export {
  type AnyToolUIPart,
  ChatInput,
  type ChatInputProps,
  type ChatStatus,
  formatRelativeTime,
  MessageItem,
  type MessageItemClassNames,
  type MessageItemProps,
  MessageItemView,
  type MessageItemViewProps,
  MessageList,
  type MessageListClassNames,
  type MessageListProps,
  type MessageUsageInfo,
  type RenderFilesFn,
  type RenderUiFn,
  type AmbientRenderUi,
  AmbientRenderUiContext,
  useAmbientRenderUi,
  type RenderReasoningFn,
  type RenderTextFn,
  type RenderToolGroupFn,
  type RenderToolPartFn,
  DEFAULT_SPEECH_LANG,
  loadStoredSpeechLang,
  persistSpeechLang,
  type SpeechLanguage,
  SPEECH_LANGUAGES,
  type SpeechRecognitionHook,
  useSpeechRecognition,
  type UseSpeechRecognitionOptions,
} from './components/index.js';
export {
  applyCompletion,
  type AutocompleteInputProps,
  type AutocompleteItem,
  type AutocompleteListboxProps,
  type AutocompleteOptionProps,
  type AutocompleteSource,
  type CompletionEdit,
  type ComposerAutocomplete,
  createSkillsSource,
  filterAutocompleteItems,
  findActiveTrigger,
  type SkillsSourceOptions,
  type SkillSuggestionData,
  type TriggerMatch,
  type TriggerPosition,
  useComposerAutocomplete,
  type UseComposerAutocompleteOptions,
} from './composer/index.js';
export {
  fillTemplate,
  phraseFor,
  readPath,
  type ToolCatalog,
  toolCatalogFrom,
} from './presentation/phrasing.js';
export {
  inferResultView,
  type ResolvedReading,
  type ResolvedResultView,
  resolveResultView,
} from './presentation/result-view.js';
export {
  correctedCallIds,
  type DescribeToolCallOptions,
  describeToolCall,
  type GroupToolActivityOptions,
  groupToolActivity,
  isActionCall,
  type ToolActivityGroup,
  type ToolCallDescription,
  type ToolCallState,
  type ToolCallStatus,
  toolCallState,
} from './presentation/tool-activity.js';
export {
  type ToolCatalogState,
  useToolCatalog,
  type UseToolCatalogOptions,
} from './presentation/use-tool-catalog.js';
export {
  type CoercibleQuestion,
  type ElicitationInput,
  type ElicitationInputType,
  type RawAnswer,
  coerceAnswer,
  validateAnswer,
  validateAnswerValue,
} from './elicitation/answers.js';
export {
  type ApprovalCountdown,
  type UseApprovalCountdownOptions,
  approvalCountdown,
  useApprovalCountdown,
} from './approvals/countdown.js';
export {
  formatElapsed,
  readReasoningMs,
  useElapsed,
  type UseElapsedOptions,
} from './reasoning/timing.js';
export { storedMessageToUiMessage } from './stored-message-to-ui-message.js';
export {
  type AggregatedTurnUsage,
  type AgentMessageMetadata,
  type StoredTurnMetadata,
  storedThreadToUiMessages,
} from './stored-thread-to-ui-messages.js';
export {
  type ApprovalBlockOptions,
  type ApproveOptions,
  type BuildBlocksOptions,
  buildTranscriptBlocks,
  type ChatTranscript,
  describeTimestamp,
  describeUsage,
  type ElicitationBlockOptions,
  extractMessageText,
  type RetrievedPassage,
  type StickToBottom,
  type StickToBottomOptions,
  type TimestampInfo,
  type TranscriptActionState,
  type TranscriptApproval,
  type TranscriptApprovalStatus,
  type TranscriptBlock,
  type TranscriptCopyState,
  type TranscriptEditState,
  type TranscriptElicitationBlock,
  type TranscriptFile,
  type TranscriptFilesBlock,
  type TranscriptElicitationOutcome,
  type TranscriptItem,
  type TranscriptItemOptions,
  type TranscriptQuestion,
  type TranscriptQuestionOption,
  type TranscriptReasoningBlock,
  type SettleAction,
  type TranscriptSettleState,
  type TranscriptSource,
  type TranscriptSourcesBlock,
  type TranscriptStopState,
  type TranscriptTextBlock,
  type TranscriptToolBlock,
  type TranscriptToolCall,
  type TranscriptUiBlock,
  type TranscriptWindow,
  type UsageSummary,
  useChatTranscript,
  type UseChatTranscriptOptions,
  useStickToBottom,
  useTranscriptItem,
  type UseTranscriptItemOptions,
} from './transcript/index.js';
export {
  type ChatBackground,
  QuotaBlockedError,
  useAgentChat,
  type UseAgentChatOptions,
} from './use-agent-chat.js';
