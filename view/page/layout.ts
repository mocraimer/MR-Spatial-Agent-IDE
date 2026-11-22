/** Where things sit. No DOM here, so the rules can be tested on their own. */
import { shelfOrder } from '../shared/actions.js';
import { currentProject, type Session, type Shelf } from '../shared/messages.js';

/** The front session: metres wide, metres away, metres below eye height at its centre. */
export const FRONT_WIDTH = 1.1, FRONT_DISTANCE = 0.9, FRONT_Y = -0.05;
/** The front spans about ±31°; the columns beside it start clear of it. */
export const TILE_WIDTH = 0.42, ARC = 1.0, FIRST_ANGLE = 46, TOP = 0.3;
/** A column's tiles fit between TOP and this far below it. */
const COLUMN_HEIGHT = 0.85, TILE_GAP = 0.03;
/** Tile canvas proportions (panels.ts TILE_SIZE): height over width. */
const TILE_ASPECT = 400 / 640;
/** Chips (inside a project) and nodes (at the overview): a row of projects above the strip. */
export const CHIP_WIDTH = 0.17, NODE_WIDTH = 0.22, CHIP_ARC = 1.0, CHIP_Y = 0.46, CHIP_GAP = 0.02, ROW_MAX = 8;
/** Chip canvas proportions (panels.ts CHIP_SIZE): height over width. */
const CHIP_ASPECT = 150 / 520;

export interface Tile { n: number; session: Session; closed: boolean }
export interface Column { projectId: string; project: string; angle: number; tiles: Tile[] }
/** A session that just closed, shown a moment longer in its project. */
export interface Closed { session: Session; projectId: string; project: string }
/** A project as one card: a chip inside another project, a node at the overview. The overview's own chip has `overview`. */
export interface Chip { projectId: string; project: string; overview: boolean; sessions: Session[]; angle: number; y: number; width: number }
export type Place = { overview: true } | { overview: false; projectId: string; project: string };

/**
 * Inside a project: that project's sessions on the shelf, the others as chips. At the overview:
 * the sessions that belong to no project on the shelf, every project as a node. Where the owner
 * is follows Herdr's focus. Sessions are numbered across all projects in shelf order.
 */
export function arrange(shelf: Shelf, closed: Iterable<Closed> = []): { front: Session | null; place: Place; columns: Column[]; chips: Chip[] } {
  const ordered = shelfOrder(shelf.projects, shelf.sessions);
  const numbers = new Map(ordered.map((s, i) => [s.id, i + 1]));
  const front = ordered.find(s => s.id === shelf.focusedId) ?? null;
  const projectId = currentProject(shelf);
  const project = shelf.projects.find(p => p.id === projectId);
  const place: Place = project ? { overview: false, projectId: project.id, project: project.label } : { overview: true };
  const here = project ? project.id : shelf.overviewId;
  const label = project ? project.label : 'Overview';

  const tiles: Tile[] = here === null ? [] : ordered.filter(s => s.workspaceId === here).map(s => ({ n: numbers.get(s.id) as number, session: s, closed: false }));
  for (const c of closed) if (c.projectId === here) tiles.push({ n: 0, session: c.session, closed: true });
  const left = Math.ceil(tiles.length / 2);
  const columns: Column[] = [
    { projectId: here ?? 'overview', project: label, angle: -FIRST_ANGLE, tiles: tiles.slice(0, left) },
    { projectId: here ?? 'overview', project: label, angle: FIRST_ANGLE, tiles: tiles.slice(left) },
  ].filter(c => c.tiles.length > 0);

  const cards = shelf.projects
    .filter(p => p.id !== shelf.overviewId && p.id !== here)
    .map(p => ({ projectId: p.id, project: p.label, overview: false, sessions: ordered.filter(s => s.workspaceId === p.id) }));
  if (project) cards.unshift({ projectId: shelf.overviewId ?? 'overview', project: 'Overview', overview: true, sessions: ordered.filter(s => s.workspaceId === shelf.overviewId) });
  const width = project ? CHIP_WIDTH : NODE_WIDTH;
  const step = (width + CHIP_GAP) / CHIP_ARC * 180 / Math.PI;
  const rowHeight = width * CHIP_ASPECT + 0.02;
  const chips = cards.map((card, i) => {
    const row = Math.floor(i / ROW_MAX);
    const inRow = Math.min(ROW_MAX, cards.length - row * ROW_MAX);
    const k = i - row * ROW_MAX;
    // The first row sits lowest, nearest the eye; further rows stack above it.
    return { ...card, angle: (k - (inRow - 1) / 2) * step, y: CHIP_Y + row * rowHeight, width };
  });
  return { front, place, columns, chips };
}

/** Vertical step between a column's tiles, and their width: a long column shrinks to fit. */
export function columnFit(tiles: number): { step: number; width: number } {
  const full = TILE_WIDTH * TILE_ASPECT + TILE_GAP;
  const step = Math.min(full, COLUMN_HEIGHT / Math.max(1, tiles));
  return { step, width: TILE_WIDTH * Math.min(1, step / full) };
}
