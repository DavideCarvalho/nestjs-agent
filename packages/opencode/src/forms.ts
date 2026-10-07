import {
  type ElicitationQuestion,
  type ElicitationRequest,
  validateElicitationAnswer,
} from '@dudousxd/nestjs-agent-core';
import type { OpenCodeForm, OpenCodeFormField, OpenCodeFormValue } from './client.js';

/** An OpenCode form field as a stream-protocol question (`docs/stream-protocol.md`, *Asking the user*). */
export function toQuestion(field: OpenCodeFormField): ElicitationQuestion {
  const required = field.required === true ? { required: true } : {};
  const base = {
    id: field.key,
    prompt: field.title || field.key,
    ...(field.description && field.description !== field.title
      ? { description: field.description }
      : {}),
  };
  if (field.options !== undefined && field.options.length > 0) {
    return {
      ...base,
      options: field.options.map((o) => ({
        value: String(o.value),
        label: String(o.label ?? o.value),
      })),
      input: { type: 'select', ...required },
      ...(field.type === 'array' ? { multiple: true } : {}),
      ...(field.custom === true ? { allowFreeText: true } : {}),
    };
  }
  const type =
    field.type === 'number' || field.type === 'integer'
      ? 'number'
      : field.type === 'boolean'
        ? 'boolean'
        : 'text';
  return { ...base, input: { type, ...required } };
}

/** The fields of a form, skipping anything that is not one. */
export function formFields(form: Pick<OpenCodeForm, 'fields'>): OpenCodeFormField[] {
  return (form.fields ?? []).filter(
    (f): f is OpenCodeFormField => typeof f === 'object' && f !== null && typeof f.key === 'string',
  );
}

/** The elicitation an OpenCode form streams as, under `id` (the tool-call id it is answered through). */
export function toElicitation(id: string, form: OpenCodeForm): ElicitationRequest {
  const questions = formFields(form).map(toQuestion);
  const first = questions[0];
  // OpenCode titles a one-question form after the question (or just "Questions"): not a preamble.
  const title = form.title;
  const preamble =
    title && title !== 'Questions' && title !== first?.prompt && title !== first?.description
      ? title
      : undefined;
  return { id, source: 'ask', ...(preamble ? { preamble } : {}), questions };
}

export class FormAnswerError extends Error {}

/**
 * The protocol's answers (question id → canonical strings) as OpenCode's form reply: numbers as
 * numbers, booleans as booleans, multiple choice as a list. Questions left out take their defaults;
 * a value a question can't take throws {@link FormAnswerError}.
 */
export function toFormAnswer(
  form: OpenCodeForm,
  answers: Record<string, string[]> = {},
): Record<string, OpenCodeFormValue> {
  const out: Record<string, OpenCodeFormValue> = {};
  for (const field of formFields(form)) {
    const question = toQuestion(field);
    const values = answers[field.key] ?? question.defaults ?? [];
    const problem = validateElicitationAnswer(question, values);
    if (problem) throw new FormAnswerError(`answers["${field.key}"] ${problem}`);
    const present = values.filter((v) => v !== '');
    const [value] = present;
    if (value === undefined) continue;
    if (question.multiple) out[field.key] = present;
    else if (question.input?.type === 'number') out[field.key] = Number(value);
    else if (question.input?.type === 'boolean') out[field.key] = value === 'true';
    else out[field.key] = value;
  }
  return out;
}
