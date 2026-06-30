import React, { useEffect, useState } from 'react';
import { useSpeechRecognition } from './use-speech-recognition.js';

export interface ChatInputProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
  /** Enable the dictation mic button (Web Speech API). Default `true`. */
  enableSpeech?: boolean;
  /** BCP-47 locale for dictation. Default `en-US`. */
  speechLang?: string;
  /** Label/content for the send button. Default `"Send"`. */
  sendLabel?: React.ReactNode;
  /** Wrapper class. The component ships no styles of its own. */
  className?: string;
  textareaClassName?: string;
  sendButtonClassName?: string;
  micButtonClassName?: string;
  /**
   * Custom mic affordance. Receives `isListening`; return any node. When
   * omitted a plain text button ("Speak" / "Stop") is rendered.
   */
  renderMic?: (state: { isListening: boolean }) => React.ReactNode;
}

/**
 * Styling-agnostic chat composer. Enter submits, Shift+Enter inserts a
 * newline. Optional dictation streams interim transcripts into the draft
 * and commits finalized chunks. No design-system or icon-library deps —
 * style it entirely through the `*ClassName` props.
 */
export function ChatInput({
  onSubmit,
  disabled,
  placeholder,
  rows = 2,
  enableSpeech = true,
  speechLang = 'en-US',
  sendLabel = 'Send',
  className,
  textareaClassName,
  sendButtonClassName,
  micButtonClassName,
  renderMic,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  // Interim dictation transcript shown appended to the draft until the
  // engine finalizes it — kept out of `value` so editing the rest of the
  // text doesn't persist a partial guess.
  const [interim, setInterim] = useState('');

  const speech = useSpeechRecognition({
    lang: speechLang,
    onFinalTranscript: (text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setValue((prev) =>
        prev.length === 0 ? trimmed : `${prev.trimEnd()} ${trimmed}`,
      );
      setInterim('');
    },
    onInterimTranscript: (text) => setInterim(text),
  });

  useEffect(() => {
    if (!speech.isListening) setInterim('');
  }, [speech.isListening]);

  function submit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue('');
    setInterim('');
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  function toggleMic() {
    if (speech.isListening) speech.stop();
    else speech.start();
  }

  const displayValue =
    speech.isListening && interim
      ? `${value}${value && !value.endsWith(' ') ? ' ' : ''}${interim}`
      : value;

  const showMic = enableSpeech && speech.isSupported;

  return (
    <div className={className}>
      <textarea
        className={textareaClassName}
        rows={rows}
        value={displayValue}
        disabled={disabled}
        onChange={(event) => {
          // Ignore changes while interim text is injected — the engine
          // overwrites it on the next result. Editing works when idle.
          if (speech.isListening && interim) return;
          setValue(event.target.value);
        }}
        onKeyDown={handleKeyDown}
        placeholder={
          placeholder ?? 'Ask something (Enter to send, Shift+Enter for newline)'
        }
      />
      <button
        type="button"
        className={sendButtonClassName}
        onClick={submit}
        disabled={disabled || !value.trim()}
      >
        {sendLabel}
      </button>
      {showMic ? (
        <button
          type="button"
          className={micButtonClassName}
          onClick={toggleMic}
          disabled={disabled}
          aria-label={speech.isListening ? 'Stop dictating' : 'Start dictating'}
        >
          {renderMic
            ? renderMic({ isListening: speech.isListening })
            : speech.isListening
              ? 'Stop'
              : 'Speak'}
        </button>
      ) : null}
    </div>
  );
}
