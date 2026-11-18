import type { AdminRole, Permission } from '../domain/permissions';

export interface AdminPrincipal {
  /** AdminUser id */
  id: string;
  email: string;
  role: AdminRole;
  permissions: ReadonlySet<Permission>;
  /** non-empty only for department-scoped roles */
  departments: readonly string[];
  departmentScoped: boolean;
  /** Supabase authenticator assurance level: aal1 | aal2 */
  aal: string;
}
