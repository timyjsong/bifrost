import type { ComponentType } from "react";
import type { Snapshot } from "../../../../shared/types";
import type { SessionGroups } from "../../lib/selectors";

/**
 * Contract every sessions view implements: same data in, any presentation
 * out. Adding a view = one component + one registry entry; the data layer
 * never changes.
 */
export interface SessionsViewProps {
  groups: SessionGroups;
  now: number;
  summarize: Snapshot["summarize"];
  isWide: boolean;
}

export interface SessionsViewDef {
  id: string;
  label: string;
  Component: ComponentType<SessionsViewProps>;
}
