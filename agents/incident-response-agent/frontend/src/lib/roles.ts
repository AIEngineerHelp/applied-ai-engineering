import type { Approval, Me, Role } from './types';

export const ROLE_ORDER: Role[] = ['viewer', 'responder', 'approver', 'admin'];

export const roleLabel: Record<Role, string> = {
  viewer: 'Viewer',
  responder: 'Responder',
  approver: 'Approver',
  admin: 'Admin',
};

function rank(role: Role): number {
  return ROLE_ORDER.indexOf(role);
}

/** The user's highest role, or null when they have none. */
export function highestRole(me: Me | undefined): Role | null {
  if (!me?.roles?.length) return null;
  return me.roles.reduce<Role | null>((best, r) => (rank(r) > (best ? rank(best) : -1) ? r : best), null);
}

/** Roles are hierarchical: each includes the ones below it. */
export function hasRole(me: Me | undefined, required: Role): boolean {
  const top = highestRole(me);
  return top !== null && rank(top) >= rank(required);
}

export function displayName(me: Me | undefined): string {
  return me?.name || me?.email || me?.sub || 'Unknown user';
}

/** Whether an approval entry was made by the current user. */
export function isOwnApproval(approval: Approval, me: Me | undefined): boolean {
  if (!me) return false;
  const by = approval.by.trim().toLowerCase();
  return [me.sub, me.email, me.name].some((v) => v && v.trim().toLowerCase() === by);
}
