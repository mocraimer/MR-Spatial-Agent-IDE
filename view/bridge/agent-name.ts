import { createHash } from 'node:crypto';

/** Herdr's rule for an agent name, from its own error: `agent.start` refuses anything else. (agentName makes letters, digits and "-" only, which the rule allows.) */
export const AGENT_NAME_RULE = /^[a-z][a-z0-9_-]{0,31}$/;

const MAX = 32;
const HASH = 6;

/**
 * The one place the view makes a Herdr agent name, from a label and the id of the pane the
 * agent starts in: lower case, letters, digits and "-", starting with a letter, at most 32
 * characters. A short hash of the unmade text ends it, so two panes never share a name even
 * when their ids differ only in capitals ("wW:p2" and "ww:p2") or are cut short.
 */
export function agentName(label: string, paneId: string): string {
  const slug = `${label} ${paneId}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const head = /^[a-z]/.test(slug) ? slug : `a-${slug}`;
  const hash = createHash('sha256').update(`${label}\0${paneId}`).digest('hex').slice(0, HASH);
  return `${head.slice(0, MAX - HASH - 1).replace(/-+$/, '')}-${hash}`;
}
