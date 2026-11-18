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

  it('MFA for bursar and super admin; department scope for heads of department', () => {
    expect(MFA_ROLES).toEqual(['SUPER_ADMIN', 'BURSAR']);
    expect(isDepartmentScoped('HEAD_OF_DEPARTMENT')).toBe(true);
    expect(isDepartmentScoped('BURSAR')).toBe(false);
  });
});
