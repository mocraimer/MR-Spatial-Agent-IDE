/**
 * Making projects from the headset. A project is a Herdr workspace (decision record
 * 20261122-levels-ride-on-herdr-workspaces); here it is made starting in a folder, so the
 * project's sessions start there. New folders go in the home folder, with git; existing folders
 * are offered from one level inside a few roots (20261122-projects-made-from-the-headset).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { dataDirectory } from './config.js';
import type { HerdrClient } from './herdr.js';
import { paneOf } from './agents.js';

/**
 * Where existing folders are looked for, one level deep: SPATIAL_PROJECT_ROOTS (colon-separated),
 * else the home folder and each folder listed, one per line, in the view's data directory's
 * `project-roots` file. That file is the owner's own, outside the repository: the folders on a PC
 * are private values.
 */
export function projectRoots(): string[] {
  const named = process.env.SPATIAL_PROJECT_ROOTS;
  if (named) return named.split(':').filter(Boolean);
  let listed: string[] = [];
  try { listed = readFileSync(join(dataDirectory(), 'project-roots'), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')); } catch { /* none listed */ }
  return [homedir(), ...listed];
}
/** Where a new project's folder is made: SPATIAL_NEW_PROJECT_ROOT or the home folder. */
export function newProjectRoot(): string { return process.env.SPATIAL_NEW_PROJECT_ROOT ?? homedir(); }

export interface Folder { path: string; name: string; changed: number; git: boolean }

/** A spoken project name as a folder name: "My Recipes!" -> "my-recipes". */
export function folderName(spoken: string): string {
  return spoken.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '').replace(/^[.-]+/, '').replace(/-+/g, '-');
}

/** A name for loose matching: case and everything but letters and digits dropped. */
export const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Folders one level inside the roots, not hidden, newest first; `taken` are working folders of sessions already in a project. */
export function folders(roots: string[], taken: string[], filter = '', gitOnly = true): Folder[] {
  const rootSet = new Set(roots.map(r => resolve(r)));
  const used = taken.map(t => resolve(t));
  const seen = new Set<string>();
  const out: Folder[] = [];
  for (const root of roots) {
    let names: string[];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const path = resolve(root, name);
      if (seen.has(path) || rootSet.has(path)) continue;
      seen.add(path);
      let stat;
      try { stat = statSync(path); } catch { continue; }
      if (!stat.isDirectory()) continue;
      let gitTime = 0;
      try { gitTime = statSync(join(path, '.git')).mtimeMs; } catch { /* no git here */ }
      const git = gitTime > 0;
      if (gitOnly && !git) continue;
      if (used.some(u => u === path || u.startsWith(`${path}/`))) continue;
      if (filter && !loose(name).includes(loose(filter))) continue;
      out.push({ path, name, changed: Math.max(stat.mtimeMs, gitTime), git });
    }
  }
  return out.sort((a, b) => b.changed - a.changed);
}

/** The working folders of every session Herdr has: a folder holding one of them is already a project's. */
export async function takenFolders(herdr: HerdrClient): Promise<string[]> {
  const snapshot = await herdr.snapshot();
  return snapshot.panes.map(p => p.cwd).filter((c): c is string => typeof c === 'string' && c.length > 0);
}

export interface Made { folder: string; workspaceId: string; paneId: string; label: string }

/** A new folder in the root with git, and a workspace labelled as said that starts in it. Never reuses a folder. */
export async function makeProject(herdr: HerdrClient, root: string, spoken: string): Promise<Made> {
  const label = spoken.trim().replace(/\s+/g, ' ');
  const name = folderName(label);
  if (!name) throw new Error(`"${spoken}" gives no folder name. Say a name with letters or digits.`);
  const folder = join(root, name);
  if (existsSync(folder)) throw new Error(`A folder named ${name} already exists in ${root}. Nothing was made; say another name, or add that folder as a project.`);
  mkdirSync(folder);
  try { execFileSync('git', ['init', '-q'], { cwd: folder, stdio: 'ignore' }); } catch (error) {
    // The folder was made a moment ago by this call (it did not exist): take it, and anything git
    // left in it, away again, so a failed make changes nothing.
    rmSync(folder, { recursive: true, force: true });
    throw new Error(`git could not set up ${folder} (${(error as Error).message}); nothing was made.`);
  }
  return { folder, label, ...await workspaceIn(herdr, folder, label) };
}

/** A workspace that starts in an existing folder, labelled with the folder's name unless one is given. */
export async function addProject(herdr: HerdrClient, folder: string, label?: string): Promise<Made> {
  const path = resolve(folder);
  let isDir = false;
  try { isDir = statSync(path).isDirectory(); } catch { /* missing */ }
  if (!isDir) throw new Error(`There is no folder ${path}.`);
  const name = label?.trim() || basename(path);
  return { folder: path, label: name, ...await workspaceIn(herdr, path, name) };
}

async function workspaceIn(herdr: HerdrClient, cwd: string, label: string): Promise<{ workspaceId: string; paneId: string }> {
  const made = await herdr.call('workspace.create', { label, cwd, focus: false });
  const workspaceId = (made.workspace as { workspace_id?: unknown } | undefined)?.workspace_id;
  if (typeof workspaceId !== 'string') throw new Error('Herdr sent an unexpected workspace');
  // Name the first tab so the Herdr tab bar is not blank (ASM-14).
  const tabId = (made.tab as { tab_id?: unknown } | undefined)?.tab_id;
  if (typeof tabId === 'string') await herdr.call('tab.rename', { tab_id: tabId, label: 'shell' });
  return { workspaceId, paneId: paneOf(made.root_pane) };
}
