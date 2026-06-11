import type { SessionsViewDef } from "./types";
import { CardsView } from "./CardsView";
import { TableView } from "./TableView";

/**
 * The sessions view registry. To add a presentation (graph, timeline, …):
 * implement SessionsViewProps in a component and add one entry here —
 * nothing else in the app changes.
 */
export const SESSIONS_VIEWS: SessionsViewDef[] = [
  { id: "cards", label: "cards", Component: CardsView },
  { id: "table", label: "table", Component: TableView },
];

export const DEFAULT_VIEW = "cards";
