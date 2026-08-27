/**
 * scopes: [frontend]
 * flags: [has-admin]
 * description: React admin page (TypeScript + Tailwind + shadcn) for managing users and assigning roles.
 */

/**
 * User Management Admin Page (TypeScript + Tailwind)
 *
 * Self-contained React component for managing users with role-based access
 * control. Allows admins to approve/deny users, change roles, and filter by
 * account status.
 *
 * Uses fetch directly (no custom client). Calls go through Traefik which
 * strips the /api prefix, so endpoints are /api/auth/users from the
 * frontend's perspective.
 *
 * Dependencies: React 18+, shadcn Button / Select / Badge / Tabs.
 *
 * Related:
 *   - snippets/auth/user-roles.ts (backend endpoints)
 *   - snippets/auth/user-roles-schema.sql (database schema)
 *
 * Usage:
 *   import UserManagement from './pages/UserManagement.js';
 *   <Route path="/admin" element={<UserManagement />} />
 */

import * as React from 'react';
import { Button } from '../frontend/components/Button.js';
import { Badge, type BadgeVariant } from '../frontend/components/Badge.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../frontend/components/Select.js';
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '../frontend/components/Tabs.js';
import { Alert, AlertDescription } from '../frontend/components/Alert.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../frontend/components/Table.js';

type AccountStatus = 'pending' | 'approved' | 'denied';
type AccountStatusFilter = 'all' | AccountStatus;
type Role = 'user' | 'expert' | 'admin';

const STATUS_OPTIONS: AccountStatusFilter[] = [
  'all',
  'pending',
  'approved',
  'denied',
];
const ROLE_OPTIONS: Role[] = ['user', 'expert', 'admin'];

const STATUS_VARIANT: Record<AccountStatus, BadgeVariant> = {
  pending: 'secondary',
  approved: 'default',
  denied: 'destructive',
};

export interface ManagedUser {
  id: string | number;
  name?: string;
  email?: string;
  account_status: AccountStatus;
  role: Role;
  last_login?: string | null;
}

export default function UserManagement(): React.JSX.Element {
  const [users, setUsers] = React.useState<ManagedUser[]>([]);
  const [filter, setFilter] = React.useState<AccountStatusFilter>('all');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const fetchUsers = React.useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const query = filter !== 'all' ? `?account_status=${filter}` : '';
      const res = await fetch(`/api/auth/users${query}`);
      if (!res.ok) throw new Error(`Failed to fetch users: ${res.status}`);
      const json = (await res.json()) as ManagedUser[];
      setUsers(json);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  React.useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  async function updateAccess(
    userId: ManagedUser['id'],
    account_status: AccountStatus
  ): Promise<void> {
    try {
      const res = await fetch(`/api/auth/users/${userId}/access`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_status }),
      });
      if (!res.ok) throw new Error(`Failed to update access: ${res.status}`);
      await fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function updateRole(userId: ManagedUser['id'], role: Role): Promise<void> {
    try {
      const res = await fetch(`/api/auth/users/${userId}/role`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) throw new Error(`Failed to update role: ${res.status}`);
      await fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const pendingCount = users.filter((u) => u.account_status === 'pending').length;

  function formatDate(dateStr?: string | null): string {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
      <h1 className="text-2xl font-bold">User Management</h1>

      <Tabs
        value={filter}
        onValueChange={(v) => setFilter(v as AccountStatusFilter)}
      >
        <TabsList>
          {STATUS_OPTIONS.map((status) => (
            <TabsTrigger key={status} value={status} className="gap-2">
              {status.charAt(0).toUpperCase() + status.slice(1)}
              {status === 'pending' && pendingCount > 0 && (
                <Badge variant="destructive" className="ml-1">
                  {pendingCount}
                </Badge>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && <p className="text-sm text-slate-500">Loading users...</p>}

      {!loading && (
        <div className="overflow-x-auto rounded-md border border-slate-200">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Last Login</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-6 text-center text-slate-400"
                  >
                    No users found.
                  </TableCell>
                </TableRow>
              )}
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>{user.name || '-'}</TableCell>
                  <TableCell>{user.email || '-'}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[user.account_status]}>
                      {user.account_status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={user.role}
                      onValueChange={(v) => updateRole(user.id, v as Role)}
                      disabled={user.account_status !== 'approved'}
                    >
                      <SelectTrigger className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLE_OPTIONS.map((r) => (
                          <SelectItem key={r} value={r}>
                            {r}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-slate-500">
                    {formatDate(user.last_login)}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      {user.account_status === 'pending' && (
                        <>
                          <Button
                            size="sm"
                            onClick={() => updateAccess(user.id, 'approved')}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => updateAccess(user.id, 'denied')}
                          >
                            Deny
                          </Button>
                        </>
                      )}
                      {user.account_status === 'denied' && (
                        <Button
                          size="sm"
                          onClick={() => updateAccess(user.id, 'approved')}
                        >
                          Approve
                        </Button>
                      )}
                      {user.account_status === 'approved' && (
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => updateAccess(user.id, 'denied')}
                        >
                          Revoke
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
