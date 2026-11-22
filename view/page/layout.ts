/** Where things sit on the shelf. No DOM here, so the rules can be tested on their own. */
import { shelfOrder } from '../shared/actions.js';
import type { Session, Shelf } from '../shared/messages.js';

/** The front session: metres wide, metres away, metres below eye height at its centre. */
export const FRONT_WIDTH = 1.1, FRONT_DISTANCE = 0.9, FRONT_Y = -0.05;
/** The front spans about ±31°; the nearest columns start clear of it. */
export const TILE_WIDTH = 0.3, ARC = 1.0, FIRST_ANGLE = 44, COLUMN_ANGLE = 19, TOP = 0.3;
/** A column's tiles fit between TOP and this far below it. */
const COLUMN_HEIGHT = 0.85, TILE_STEP = 0.215;

export interface Tile { n: number; session: Session; closed: boolean }
export interface Column { projectId: string; project: string; angle: number; tiles: Tile[] }
/** A session that just closed, shown a moment longer in its project's column. */
export interface Closed { session: Session; projectId: string; project: string }

/**
 * Projects split left and right of the front session, the first half (rounded up) on the left;
 * each project is a column of its sessions, numbered in shelf order.
 */
export function arrange(shelf: Shelf, closed: Iterable<Closed> = []): { front: Session | null; columns: Column[] } {
  const ordered = shelfOrder(shelf.projects, shelf.sessions);
  const numbers = new Map(ordered.map((s, i) => [s.id, i + 1]));
  const groups = shelf.projects
    .map(p => ({ projectId: p.id, project: p.label, tiles: ordered.filter(s => s.workspaceId === p.id).map(s => ({ n: numbers.get(s.id) as number, session: s, closed: false })) }))
    .filter(g => g.tiles.length > 0);
  for (const c of closed) {
    const tile = { n: 0, session: c.session, closed: true };
    const group = groups.find(g => g.projectId === c.projectId);
    if (group) group.tiles.push(tile); else groups.push({ projectId: c.projectId, project: c.project, tiles: [tile] });
  }
  const left = Math.ceil(groups.length / 2);
  const columns = groups.map((g, i) => ({ ...g, angle: i < left ? -(FIRST_ANGLE + i * COLUMN_ANGLE) : FIRST_ANGLE + (i - left) * COLUMN_ANGLE }));
  return { front: ordered.find(s => s.id === shelf.focusedId) ?? null, columns };
}

/** Vertical step between a column's tiles, and their width: a long column shrinks to fit. */
export function columnFit(tiles: number): { step: number; width: number } {
  const step = Math.min(TILE_STEP, COLUMN_HEIGHT / Math.max(1, tiles));
  return { step, width: TILE_WIDTH * Math.min(1, step / TILE_STEP) };
}
