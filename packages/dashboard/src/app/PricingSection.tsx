import { type FormEvent, type ReactNode, useState } from 'react';
import type { ModelPrice, UpsertModelPriceInput } from '../client/agent-client';
import { formatModelLabel } from '../client/format-model';
import { formatUsd } from '../client/format-usd';
import { Button } from './ui/button';
import { BareInput } from './ui/input';
import { Empty, Panel, relTime } from './ui/kit';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeadRow,
  TableHeader,
  TableRow,
} from './ui/table';
import { Tooltip } from './ui/tooltip';

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
        <div className="rounded-lg border border-dashed border-line p-6 text-xs text-muted-foreground">
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
          <div className="animate-pulse text-xs text-muted-foreground">Loading…</div>
        ) : prices.length === 0 ? (
          <Empty label="No prices set yet" />
        ) : (
          <Table className="min-w-[560px]">
            <TableHeader>
              <TableHeadRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Input / 1M</TableHead>
                <TableHead className="text-right">Output / 1M</TableHead>
                <TableHead className="text-right">Cache write / 1M</TableHead>
                <TableHead className="text-right">Cache read / 1M</TableHead>
                <TableHead className="pl-4">Effective</TableHead>
              </TableHeadRow>
            </TableHeader>
            <TableBody>
              {prices.map((price) => (
                <TableRow key={price.modelId}>
                  <TableCell className="pr-4">
                    <Tooltip label={price.modelId}>
                      <span className="block max-w-[240px] truncate text-foreground">
                        {formatModelLabel(price.modelId)}
                      </span>
                    </Tooltip>
                  </TableCell>
                  <TableCell className="text-right text-foreground">
                    {formatUsd(price.inputPricePer1m)}
                  </TableCell>
                  <TableCell className="text-right text-foreground">
                    {formatUsd(price.outputPricePer1m)}
                  </TableCell>
                  <TableCell className="text-right">
                    {price.cacheWritePricePer1m !== undefined
                      ? formatUsd(price.cacheWritePricePer1m)
                      : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {price.cacheReadPricePer1m !== undefined
                      ? formatUsd(price.cacheReadPricePer1m)
                      : '—'}
                  </TableCell>
                  <TableCell className="pl-4 text-[10px]">{relTime(price.effectiveFrom)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
        <BareInput
          required
          value={form.modelId}
          onChange={(event) => setForm({ ...form, modelId: event.target.value })}
          placeholder="gpt-4o"
          className="w-40"
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
      <Button type="submit" variant="default" size="md" disabled={saving} className="rounded-lg">
        {saving ? 'Saving…' : 'Save price'}
      </Button>
      {error && <span className="text-xs text-bad">{error}</span>}
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
    <label className="flex flex-col gap-1 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-[11px] text-muted-foreground">
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
    <BareInput
      type="number"
      min={0}
      step="0.01"
      value={value ?? ''}
      onChange={(event) => {
        const raw = event.target.value;
        onChange(raw === '' ? undefined : Number(raw));
      }}
      className="tnum w-24"
    />
  );
}
