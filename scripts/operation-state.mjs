import { readFileSync } from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import {
  backupWorkspace, checkRollbackUnchanged, OperationError, restoreDetached,
  verifyBackup, verifyMaintenance,
} from '../build/host/src/operations.js';

// Trusted owner-local CLI only. No implicit live root, environment variables, grants,
// provider calls, service control, restore activation or recursive deletion command.
const [command, input, ...extra] = process.argv.slice(2);
try {
  if (!input || extra.length || !['backup', 'verify', 'restore-detached', 'rollback-check'].includes(command)) {
    throw new OperationError('usage', 'Use: node scripts/operation-state.mjs backup|verify|restore-detached|rollback-check INPUT');
  }
  if (command === 'verify') {
    const result = verifyBackup(input);
    console.log(JSON.stringify({ state: 'verified', operationId: result.operationId, files: result.files.length }));
  } else {
    const config = JSON.parse(readFileSync(input, 'utf8'));
    // Owner attestations are checked again at each API boundary, never replaced by a
    // constant-success callback. This CLI cannot discover/fence independent writers.
    const verifyQuiescence = () => {
      if (config.maintenance?.mode !== 'owner-approved-quiesced') throw new OperationError('maintenance-required', 'CLI state operations requiring a hold need reviewed owner maintenance; fixture mode belongs only in isolated tests.');
      verifyMaintenance(config.maintenance);
    };
    if (command === 'backup' || command === 'rollback-check' || config.current?.speechJournal !== undefined || config.current?.speechIdentity !== undefined) verifyQuiescence();
    if (command === 'backup') {
      const result = backupWorkspace({ ...config, verifyQuiescence });
      console.log(JSON.stringify({ state: 'backed-up', operationId: result.operationId, files: result.files.length, activation: 'not-authorized' }));
    } else if (command === 'restore-detached') {
      const result = restoreDetached({ ...config, verifyQuiescence });
      console.log(JSON.stringify({ state: 'detached-inspection', backupOperationId: result.backupOperationId, activation: result.activation }));
    } else {
      checkRollbackUnchanged(config.backup, config.current, config.maintenance, verifyQuiescence);
      console.log(JSON.stringify({ state: 'unchanged', activation: 'not-authorized', detail: 'No state was replaced. Existing reviewed explicit owner cutover is still required.' }));
    }
  }
} catch (error) {
  // Filesystem/SQLite errors can contain sensitive paths/content. Do not dump raw diagnostics.
  const code = error instanceof OperationError ? error.code : 'operation-failed';
  console.error(JSON.stringify({ state: 'failed', code, recovery: 'Keep current state and incomplete output. Check the private owner configuration and docs/OPERATIONS.md; never retry by overwriting live state or removing locks.' }));
  process.exitCode = 1;
}
