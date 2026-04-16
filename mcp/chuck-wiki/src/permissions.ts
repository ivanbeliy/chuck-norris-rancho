export type Capability =
  | 'search_notes'
  | 'read_note'
  | 'list_backlinks'
  | 'recent'
  | 'check_similarity'
  | 'propose_note'
  | 'append_observation'
  | 'contribute_artifact'
  | 'integrate_proposal'
  | 'reject_proposal';

const CAPS_READ: Capability[] = ['search_notes', 'read_note', 'list_backlinks', 'recent', 'check_similarity'];
const CAPS_CONTRIBUTE: Capability[] = ['propose_note', 'append_observation', 'contribute_artifact'];
const CAPS_ADMIN: Capability[] = ['integrate_proposal', 'reject_proposal'];

function matches(identity: string, prefix: string): boolean {
  return identity === prefix || identity.startsWith(prefix + '-') || identity.startsWith(prefix + '/');
}

export function canCall(identity: string, cap: Capability): boolean {
  if (matches(identity, 'chuck-main') || matches(identity, 'chuck-wiki')) {
    return true;
  }
  if (identity.startsWith('chuck-project') || identity.startsWith('workstation')) {
    return CAPS_READ.includes(cap) || CAPS_CONTRIBUTE.includes(cap);
  }
  return CAPS_READ.includes(cap);
}

export function assertCan(identity: string, cap: Capability): void {
  if (!canCall(identity, cap)) {
    throw new Error(`permission denied: identity "${identity}" cannot call "${cap}"`);
  }
}
