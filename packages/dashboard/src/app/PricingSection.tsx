import { type FormEvent, type ReactNode, useState } from 'react';
import type { ModelPrice, UpsertModelPriceInput } from '../client/agent-client';
import { formatModelLabel } from '../client/format-model';
import { formatUsd } from '../client/format-usd';
import { Empty, Panel, relTime } from './ui';

const EMPTY_FORM: UpsertModelPriceInput = {
  modelId: '',
  inputPricePer1m: 0,
  outputPricePer1m: 0,
};

/**
 * Pricing tab: the current per-model rate table plus a minimal upsert form. Backed by the OPTIONAL
 * `AGENT_PRICING_STORE` — `unavailable` renders the "no pricing store bound" state the API 501s with,
 * so this replaces the hand-written pricing controller + curation UI consumers otherwise write.
 */
export function PricingSection({
  prices,
  loading,
  unavailable,
  onUpsert,
  saving,
}: {
  prices: ModelPrice[];
  loading: boolean;
  unavailable: boolean;
  onUpsert: (input: UpsertModelPriceInput) => Promise<void>;
  saving: boolean;
}) {
  if (unavailable) {
    return (
      <Panel title="Pricing" subtitle="Per-model rates cost is priced against">
        <div className="rounded-lg border border-dashed border-[var(--line)] p-6 text-xs text-[var(--muted)]">
          No pricing store is bound on the host — pricing CRUD is unavailable. Bind
          `AGENT_PRICING_STORE` (e.g. `MikroOrmPricingStore`) to enable it.
        </div>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Set a price" subtitle="Upserts the model's current rate, effective now">
        <PriceForm onUpsert={onUpsert} saving={saving} />
      </Panel>

      <Panel
        title="Current prices"
        subtitle="One live row per model — the rate cost is priced against"
      >
        {loading ? (
          <div className="animate-pulse text-xs text-[var(--muted)]">Loading…</div>
        ) : prices.length === 0 ? (
          <Empty label="No prices set yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
                <tr className="border-b border-[var(--line)]">
                  <th className="py-2 font-medium">Model</th>
                  <th className="py-2 text-right font-medium">Input / 1M</th>
                  <th className="py-2 text-right font-medium">Output / 1M</th>
                  <th className="py-2 text-right font-medium">Cache write / 1M</th>
                  <th className="py-2 text-right font-medium">Cache read / 1M</th>
                  <th className="py-2 pl-4 font-medium">Effective</th>
                </tr>
              </thead>
              <tbody className="mono tnum">
                {prices.map((price) => (
                  <tr key={price.modelId} className="border-b border-[var(--line-soft)]">
                    <td className="py-2.5 pr-4">
                      <span
                        className="block max-w-[240px] truncate text-[var(--text)]"
                        title={price.modelId}
                      >
                        {formatModelLabel(price.modelId)}
                      </span>
                    </td>
                    <td className="py-2.5 text-right text-[var(--text)]">
                      {formatUsd(price.inputPricePer1m)}
                    </td>
                    <td className="py-2.5 text-right text-[var(--text)]">
                      {formatUsd(price.outputPricePer1m)}
                    </td>
                    <td className="py-2.5 text-right text-[var(--muted)]">
                      {price.cacheWritePricePer1m !== undefined
                        ? formatUsd(price.cacheWritePricePer1m)
                        : '—'}
                    </td>
                    <td className="py-2.5 text-right text-[var(--muted)]">
                      {price.cacheReadPricePer1m !== undefined
                        ? formatUsd(price.cacheReadPricePer1m)
                        : '—'}
                    </td>
                    <td className="py-2.5 pl-4 text-[10px] text-[var(--muted)]">
                      {relTime(price.effectiveFrom)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function PriceForm({
  onUpsert,
  saving,
}: {
  onUpsert: (input: UpsertModelPriceInput) => Promise<void>;
  saving: boolean;
}) {
  const [form, setForm] = useState<UpsertModelPriceInput>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      await onUpsert(form);
      setForm(EMPTY_FORM);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to save the price.');
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <Field label="Model id">
        <input
          required
          value={form.modelId}
          onChange={(event) => setForm({ ...form, modelId: event.target.value })}
          placeholder="gpt-4o"
          className="mono w-40 bg-transparent text-[var(--text)] outline-none"
        />
      </Field>
      <Field label="Input / 1M">
        <NumberInput
          value={form.inputPricePer1m}
          onChange={(value) => setForm({ ...form, inputPricePer1m: value ?? 0 })}
        />
      </Field>
      <Field label="Output / 1M">
        <NumberInput
          value={form.outputPricePer1m}
          onChange={(value) => setForm({ ...form, outputPricePer1m: value ?? 0 })}
        />
      </Field>
      <Field label="Cache write / 1M (optional)">
        <NumberInput
          value={form.cacheWritePricePer1m}
          onChange={(value) => setForm(withOptionalNumber(form, 'cacheWritePricePer1m', value))}
        />
      </Field>
      <Field label="Cache read / 1M (optional)">
        <NumberInput
          value={form.cacheReadPricePer1m}
          onChange={(value) => setForm(withOptionalNumber(form, 'cacheReadPricePer1m', value))}
        />
      </Field>
      <button
        type="submit"
        disabled={saving}
        className="rounded-lg border border-[var(--accent)]/50 bg-[var(--accent)]/10 px-3 py-1.5 text-xs text-[var(--text)] transition-colors hover:bg-[var(--accent)]/20 disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save price'}
      </button>
      {error && <span className="text-xs text-[var(--bad)]">{error}</span>}
    </form>
  );
}

/**
 * Set (or, on `undefined`, OMIT — never assign a literal `undefined`, `exactOptionalPropertyTypes`
 * forbids it) an optional cache-price key on the form.
 */
function withOptionalNumber(
  form: UpsertModelPriceInput,
  key: 'cacheWritePricePer1m' | 'cacheReadPricePer1m',
  value: number | undefined,
): UpsertModelPriceInput {
  if (value === undefined) {
    const next = { ...form };
    delete next[key];
    return next;
  }
  return { ...form, [key]: value };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: children is always the field's input, nested inside.
    <label className="flex flex-col gap-1 rounded-lg border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-[11px] text-[var(--muted)]">
      <span className="uppercase tracking-wider">{label}</span>
      {children}
    </label>
  );
}

function NumberInput({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <input
      type="number"
      min={0}
      step="0.01"
      value={value ?? ''}
      onChange={(event) => {
        const raw = event.target.value;
        onChange(raw === '' ? undefined : Number(raw));
      }}
      className="mono tnum w-24 bg-transparent text-[var(--text)] outline-none"
    />
  );
}
