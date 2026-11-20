import { effectivePermissions, isDepartmentScoped, MFA_ROLES, ROLE_PERMISSIONS } from './permissions';

describe('roles and permissions', () => {
  it('super admin has everything, auditor reads everything and writes nothing', () => {
    expect(effectivePermissions('SUPER_ADMIN', []).has('payouts.manage')).toBe(true);
    const auditor = effectivePermissions('AUDITOR', []);
    expect(auditor.has('audit.read')).toBe(true);
    expect([...auditor].every((p) => p.endsWith('.read'))).toBe(true);
  });

  it('money-out is super-admin only by default, but grantable', () => {
    expect(ROLE_PERMISSIONS.BURSAR).not.toContain('payouts.manage');
    expect(effectivePermissions('BURSAR', ['payouts.manage']).has('payouts.manage')).toBe(true);
  });

  it('single permissions can be granted on their own; unknown ones are ignored', () => {
    const p = effectivePermissions('FINANCE_OFFICER', ['instalments.manage', 'everything.godmode']);
    expect(p.has('instalments.manage')).toBe(true);
    expect([...p]).not.toContain('everything.godmode');
  });

  it('MFA for bursar and super admin; department scope for heads of department and deans', () => {
    expect(MFA_ROLES).toEqual(['SUPER_ADMIN', 'BURSAR']);
    expect(isDepartmentScoped('HEAD_OF_DEPARTMENT')).toBe(true);
    expect(isDepartmentScoped('DEAN')).toBe(true);
    expect(isDepartmentScoped('BURSAR')).toBe(false);
    expect(ROLE_PERMISSIONS.DEAN).toEqual(ROLE_PERMISSIONS.HEAD_OF_DEPARTMENT);
  });

  it('commission transfers: super admin only by default, grantable', () => {
    for (const role of ['BURSAR', 'FINANCE_OFFICER', 'HEAD_OF_DEPARTMENT', 'DEAN', 'AUDITOR'] as const) {
      expect(effectivePermissions(role, []).has('transfers.read')).toBe(false);
      expect(effectivePermissions(role, []).has('transfers.retry')).toBe(false);
    }
    expect(effectivePermissions('SUPER_ADMIN', []).has('transfers.read')).toBe(true);
    expect(effectivePermissions('AUDITOR', ['transfers.read']).has('transfers.read')).toBe(true);
  });

  it('only super admins manage faculties and departments by default', () => {
    expect(effectivePermissions('SUPER_ADMIN', []).has('academics.manage')).toBe(true);
    expect(effectivePermissions('BURSAR', []).has('academics.manage')).toBe(false);
  });
});
