/**
 * The helper's way to make projects: `node project-tool.js <command>`, run in its Herdr pane.
 *
 *   new <name>          a new folder in the home folder with git, and a project starting in it
 *   find <name>         folders matching a name, one level inside the project roots (git or not)
 *   add <folder> [name] a project starting in an existing folder
 *   folders [filter]    git folders that are not a project yet, newest first
 *
 * It never moves, changes or deletes a folder, and never changes what is in front of the owner.
 */
import { HerdrClient } from './herdr.js';
import { addProject, folders, makeProject, newProjectRoot, projectRoots, takenFolders } from './projects.js';

const [command, ...rest] = process.argv.slice(2);
const socket = process.env.HERDR_SOCKET_PATH;
function fail(message: string): never { console.error(message); process.exit(1); }
if (!socket) fail('This tool runs only inside a Herdr pane.');
const herdr = new HerdrClient(socket);
const words = rest.join(' ').trim();

try {
  switch (command) {
    case 'new': {
      if (!words) fail('Usage: new <name>');
      const made = await makeProject(herdr, newProjectRoot(), words);
      console.log(`Made project "${made.label}" in ${made.folder} (git set up). Say "go to ${made.label}" to go there.`);
      break;
    }
    case 'find': {
      if (!words) fail('Usage: find <name>');
      const found = folders(projectRoots(), [], words, false);
      if (found.length === 0) console.log(`No folder matching "${words}" one level inside ${projectRoots().join(', ')}.`);
      for (const f of found.slice(0, 10)) console.log(`${f.path}${f.git ? '' : '  (no git)'}`);
      break;
    }
    case 'add': {
      const [folder, ...label] = rest;
      if (!folder) fail('Usage: add <folder> [name]');
      const made = await addProject(herdr, folder, label.join(' '));
      console.log(`Made project "${made.label}" starting in ${made.folder}. Say "go to ${made.label}" to go there.`);
      break;
    }
    case 'folders': {
      const found = folders(projectRoots(), await takenFolders(herdr), words);
      if (found.length === 0) console.log('No git folder that is not a project yet.');
      for (const f of found.slice(0, 20)) console.log(f.path);
      break;
    }
    default: fail('Commands: new <name> | find <name> | add <folder> [name] | folders [filter]');
  }
} catch (error) { fail((error as Error).message); }
