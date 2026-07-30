/**
 * Pure view-model for the System pane's health panel: the alert-engine signals
 * (SystemDiagnostics, surfaced in the snapshot) turned into labelled rows with a
 * severity tone + an overall roll-up. Kept pure so the tone bands are tested,
 * not eyeballed.
 *
 * The gauge bands mirror the alert-policy DEFAULT thresholds (shared/alerts.ts):
 * memory-pressure warns where `mem_stall` defaults to fire (PSI 40), swap warns
 * where `swap_ceiling` defaults to fire (70%). So a "warn" row means "you're in
 * the zone that would alert on the default policy" — an honest read even though
 * the live policy is user-tunable elsewhere.
 */
import type { SystemDiagnostics } from "../../../shared/types";
import { fmtKb } from "./format";

export type DiagTone = "ok" | "warn" | "danger";

export interface DiagRow {
  key: string;
  label: string;
  value: string;
  sub?: string;
  tone: DiagTone;
}

export interface DiagnosticsView {
  rows: DiagRow[];
  overall: DiagTone;
}

const RANK: Record<DiagTone, number> = { ok: 0, warn: 1, danger: 2 };

/** Gauge band → tone: below warn = ok, in [warn, danger) = warn, ≥ danger = danger. */
function band(value: number, warn: number, danger: number): DiagTone {
  if (value >= danger) return "danger";
  if (value >= warn) return "warn";
  return "ok";
}

export function buildDiagnostics(d: SystemDiagnostics): DiagnosticsView {
  const rows: DiagRow[] = [
    {
      key: "mem_pressure",
      label: "memory pressure",
      value: `${Math.round(d.psiMemSome)}`,
      sub: "PSI some avg10",
      tone: band(d.psiMemSome, 40, 70),
    },
    {
      key: "swap",
      label: "swap",
      value: `${Math.round(d.swapPct)}%`,
      sub: `${fmtKb(d.swapCurrentKb)} of cap`,
      tone: band(d.swapPct, 70, 90),
    },
    {
      key: "slice_cap",
      label: "slice cap",
      value: d.sliceMaxKb === null ? "unbounded" : fmtKb(d.sliceMaxKb),
      sub: "user slice memory.max",
      tone: "ok",
    },
    {
      key: "oom_kill",
      label: "OOM kills",
      value: d.oomKill === 0 ? "none" : String(d.oomKill),
      sub: "since slice start",
      tone: d.oomKill > 0 ? "warn" : "ok",
    },
    {
      key: "ram_wall",
      label: "RAM ceiling hits",
      value: d.ramWall === 0 ? "none" : String(d.ramWall),
      sub: "allocations refused",
      tone: d.ramWall > 0 ? "warn" : "ok",
    },
    {
      key: "services",
      label: "watched services",
      value: d.servicesDown.length ? d.servicesDown.join(", ") : "all up",
      sub: d.servicesDown.length ? `${d.servicesDown.length} down` : undefined,
      tone: d.servicesDown.length ? "danger" : "ok",
    },
    {
      key: "safeguard",
      label: "memory safeguard",
      value: d.limitsHealthy ? "healthy" : (d.limitsReason ?? "degraded"),
      tone: d.limitsHealthy ? "ok" : "danger",
    },
  ];

  const overall = rows.reduce<DiagTone>(
    (worst, r) => (RANK[r.tone] > RANK[worst] ? r.tone : worst),
    "ok",
  );
  return { rows, overall };
}
