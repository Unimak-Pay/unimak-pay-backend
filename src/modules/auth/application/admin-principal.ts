import type { AdminRole, Permission } from '../domain/permissions';

export interface AdminPrincipal {
  /** AdminUser id */
  id: string;
  email: string;
  role: AdminRole;
  permissions: ReadonlySet<Permission>;
  /** Department codes this admin is limited to (department-scoped roles only; for a dean, resolved from their faculties) */
  departments: readonly string[];
  /** DEAN: Faculty codes */
  faculties: readonly string[];
  departmentScoped: boolean;
  /** Supabase authenticator assurance level: aal1 | aal2 */
  aal: string;
}
