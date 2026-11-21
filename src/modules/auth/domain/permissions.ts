/**
 * Admin permissions. Roles are bundles; single permissions can be granted on
 * their own via AdminUser.extraPermissions (e.g. instalments.manage).
 */
export const PERMISSIONS = [
  'fees.read',
  'fees.manage',
  'instalments.manage',
  'payers.read',
  'payers.adjust',
  'payments.read',
  'payments.export',
  'payments.refund',
  'payments.reconcile',
  'receipts.resend',
  'accounts.read',
  'accounts.manage',
  'payouts.read',
  'payouts.manage',
  'transfers.read',
  'transfers.retry',
  'reconciliation.read',
  'reconciliation.manage',
  'outbox.read',
  'outbox.retry',
  'reports.read',
  'audit.read',
  'users.manage',
  'settings.manage',
  'academics.manage',
  'portal.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type AdminRole = 'SUPER_ADMIN' | 'BURSAR' | 'FINANCE_OFFICER' | 'HEAD_OF_DEPARTMENT' | 'DEAN' | 'AUDITOR';

/** Commission transfers (UNIMAK's share moving to the platform): super admins, or granted on their own. */
export const COMMISSION_PERMISSION: Permission = 'transfers.read';

const READ_ALL = PERMISSIONS.filter((p) => p.endsWith('.read') && p !== COMMISSION_PERMISSION);

/**
 * From the spec's role table. Money-out (payouts.manage) and account
 * provisioning (accounts.manage) are super-admin only by default; grant them
 * individually if the bursar should have them. So is seeing commission
 * transfers (transfers.read, transfers.retry).
 */
export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  SUPER_ADMIN: PERMISSIONS,
  BURSAR: [
    'fees.read', 'fees.manage', 'instalments.manage',
    'payers.read', 'payers.adjust',
    'payments.read', 'payments.export', 'payments.refund', 'payments.reconcile',
    'receipts.resend',
    'accounts.read', 'payouts.read',
    'reconciliation.read', 'reconciliation.manage', 'outbox.read', 'outbox.retry', 'portal.read',
    'reports.read',
  ],
  FINANCE_OFFICER: [
    'payers.read', 'payments.read', 'payments.export', 'receipts.resend',
    'accounts.read', 'payouts.read', 'reconciliation.read', 'reports.read',
  ],
  HEAD_OF_DEPARTMENT: ['fees.read', 'payers.read', 'payments.read', 'reports.read'],
  DEAN: ['fees.read', 'payers.read', 'payments.read', 'reports.read'],
  AUDITOR: READ_ALL,
};

/** Spec: 2FA required for bursar and super admin. */
export const MFA_ROLES: readonly AdminRole[] = ['SUPER_ADMIN', 'BURSAR'];

export function isPermission(p: string): p is Permission {
  return (PERMISSIONS as readonly string[]).includes(p);
}

export function effectivePermissions(role: AdminRole, extra: readonly string[]): Set<Permission> {
  return new Set<Permission>([...ROLE_PERMISSIONS[role], ...extra.filter(isPermission)]);
}

/** Heads of department see their departments' payers and payments; deans every department of their faculties. */
export function isDepartmentScoped(role: AdminRole): boolean {
  return role === 'HEAD_OF_DEPARTMENT' || role === 'DEAN';
}
