import type { SessionFilters } from "../lib/sessionFilters";
import {
  IDLE_PRESETS,
  RESIDENCE_OPTS,
  MODEL_OPTS,
  isFiltering,
  NO_FILTERS,
} from "../lib/sessionFilters";

/** One labeled group of filter pills — same language as the view toggle and
 *  the Projects realm filter, no native popups to fight the theme. */
function PillGroup({
  label,
  value,
  options,
  onSelect,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onSelect: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-[0.16em] text-ink-mute/80">
        {label}
      </span>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onSelect(o.value)}
          className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
            value === o.value
              ? "border-gold-dim/60 text-gold"
              : "border-line text-ink-mute hover:text-ink-dim"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SessionFilterBar({
  filters,
  onChange,
  shown,
  total,
}: {
  filters: SessionFilters;
  onChange: (f: SessionFilters) => void;
  shown: number;
  total: number;
}) {
  const idleLabel =
    IDLE_PRESETS.find((p) => p.value === filters.maxIdleMs)?.label ?? "any";

  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2">
      <PillGroup
        label="where"
        value={filters.residence}
        options={RESIDENCE_OPTS.map((v) => ({ value: v, label: v }))}
        onSelect={(v) =>
          onChange({ ...filters, residence: v as SessionFilters["residence"] })
        }
      />
      <PillGroup
        label="model"
        value={filters.model}
        options={MODEL_OPTS.map((v) => ({ value: v, label: v }))}
        onSelect={(v) =>
          onChange({ ...filters, model: v as SessionFilters["model"] })
        }
      />
      <PillGroup
        label="active"
        value={idleLabel}
        options={IDLE_PRESETS.map((p) => ({ value: p.label, label: p.label }))}
        onSelect={(label) =>
          onChange({
            ...filters,
            maxIdleMs:
              IDLE_PRESETS.find((p) => p.label === label)?.value ?? null,
          })
        }
      />
      {isFiltering(filters) && (
        <button
          onClick={() => onChange(NO_FILTERS)}
          className="text-[11px] text-ink-mute underline decoration-line underline-offset-4 transition-colors hover:text-ink-dim"
        >
          clear · {shown}/{total}
        </button>
      )}
    </div>
  );
}
