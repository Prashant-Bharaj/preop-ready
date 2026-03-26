/**
 * SNIPPET: User Management Admin Page (React)
 * CATEGORY: Authentication
 * LANGUAGE: JavaScript (React)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   Self-contained React component for managing users with role-based
 *   access control. Allows admins to approve/deny users, change roles,
 *   and filter by account status.
 *
 *   Uses fetch API directly (no custom client). Calls go through
 *   Traefik which strips the /api prefix, so endpoints are
 *   /api/auth/users from the frontend's perspective.
 *
 * DEPENDENCIES:
 *   React 18+
 *
 * RELATED:
 *   - snippets/auth/user-roles.js (backend endpoints)
 *   - snippets/auth/user-roles-schema.sql (database schema)
 *
 * USAGE:
 *   import UserManagement from './pages/UserManagement';
 *   <Route path="/admin" element={<UserManagement />} />
 */

import React, { useState, useEffect, useCallback } from 'react';

const STATUS_OPTIONS = ['all', 'pending', 'approved', 'denied'];
const ROLE_OPTIONS = ['user', 'expert', 'admin'];

const STATUS_COLORS = {
  pending: { background: '#fef3c7', color: '#92400e' },
  approved: { background: '#d1fae5', color: '#065f46' },
  denied: { background: '#fee2e2', color: '#991b1b' },
};

export default function UserManagement() {
  const [users, setUsers] = useState([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const query = filter !== 'all' ? `?account_status=${filter}` : '';
      const res = await fetch(`/api/auth/users${query}`);
      if (!res.ok) throw new Error(`Failed to fetch users: ${res.status}`);
      setUsers(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const updateAccess = async (userId, account_status) => {
    try {
      const res = await fetch(`/api/auth/users/${userId}/access`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_status }),
      });
      if (!res.ok) throw new Error(`Failed to update access: ${res.status}`);
      await fetchUsers();
    } catch (err) {
      setError(err.message);
    }
  };

  const updateRole = async (userId, role) => {
    try {
      const res = await fetch(`/api/auth/users/${userId}/role`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) throw new Error(`Failed to update role: ${res.status}`);
      await fetchUsers();
    } catch (err) {
      setError(err.message);
    }
  };

  const pendingCount = users.filter(u => u.account_status === 'pending').length;

  const formatDate = (dateStr) => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '24px', fontWeight: 'bold', marginBottom: '24px' }}>
        User Management
      </h1>

      {/* Status filter tabs */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', flexWrap: 'wrap' }}>
        {STATUS_OPTIONS.map((status) => (
          <button
            key={status}
            onClick={() => setFilter(status)}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: '1px solid #d1d5db',
              background: filter === status ? '#2563eb' : '#fff',
              color: filter === status ? '#fff' : '#374151',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: filter === status ? '600' : '400',
            }}
          >
            {status.charAt(0).toUpperCase() + status.slice(1)}
            {status === 'pending' && pendingCount > 0 && (
              <span style={{
                marginLeft: '6px',
                background: filter === 'pending' ? '#fff' : '#ef4444',
                color: filter === 'pending' ? '#2563eb' : '#fff',
                borderRadius: '999px',
                padding: '1px 8px',
                fontSize: '12px',
                fontWeight: '600',
              }}>
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Error message */}
      {error && (
        <div style={{
          padding: '12px 16px',
          background: '#fee2e2',
          color: '#991b1b',
          borderRadius: '6px',
          marginBottom: '16px',
        }}>
          {error}
        </div>
      )}

      {/* Loading state */}
      {loading && <p style={{ color: '#6b7280' }}>Loading users...</p>}

      {/* Users table */}
      {!loading && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                <th style={{ textAlign: 'left', padding: '12px 8px', color: '#6b7280' }}>Name</th>
                <th style={{ textAlign: 'left', padding: '12px 8px', color: '#6b7280' }}>Email</th>
                <th style={{ textAlign: 'left', padding: '12px 8px', color: '#6b7280' }}>Status</th>
                <th style={{ textAlign: 'left', padding: '12px 8px', color: '#6b7280' }}>Role</th>
                <th style={{ textAlign: 'left', padding: '12px 8px', color: '#6b7280' }}>Last Login</th>
                <th style={{ textAlign: 'left', padding: '12px 8px', color: '#6b7280' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: '24px', textAlign: 'center', color: '#9ca3af' }}>
                    No users found.
                  </td>
                </tr>
              )}
              {users.map((user) => (
                <tr key={user.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
                  <td style={{ padding: '12px 8px' }}>{user.name || '-'}</td>
                  <td style={{ padding: '12px 8px' }}>{user.email || '-'}</td>
                  <td style={{ padding: '12px 8px' }}>
                    <span style={{
                      display: 'inline-block',
                      padding: '2px 10px',
                      borderRadius: '999px',
                      fontSize: '12px',
                      fontWeight: '600',
                      ...STATUS_COLORS[user.account_status],
                    }}>
                      {user.account_status}
                    </span>
                  </td>
                  <td style={{ padding: '12px 8px' }}>
                    <select
                      value={user.role}
                      disabled={user.account_status !== 'approved'}
                      onChange={(e) => updateRole(user.id, e.target.value)}
                      style={{
                        padding: '4px 8px',
                        borderRadius: '4px',
                        border: '1px solid #d1d5db',
                        fontSize: '13px',
                        opacity: user.account_status !== 'approved' ? 0.5 : 1,
                        cursor: user.account_status !== 'approved' ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {ROLE_OPTIONS.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </td>
                  <td style={{ padding: '12px 8px', color: '#6b7280' }}>
                    {formatDate(user.last_login)}
                  </td>
                  <td style={{ padding: '12px 8px' }}>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      {/* Pending: Approve + Deny */}
                      {user.account_status === 'pending' && (
                        <>
                          <button
                            onClick={() => updateAccess(user.id, 'approved')}
                            style={{
                              padding: '4px 12px',
                              borderRadius: '4px',
                              border: 'none',
                              background: '#16a34a',
                              color: '#fff',
                              fontSize: '13px',
                              cursor: 'pointer',
                            }}
                          >
                            Approve
                          </button>
                          <button
                            onClick={() => updateAccess(user.id, 'denied')}
                            style={{
                              padding: '4px 12px',
                              borderRadius: '4px',
                              border: 'none',
                              background: '#dc2626',
                              color: '#fff',
                              fontSize: '13px',
                              cursor: 'pointer',
                            }}
                          >
                            Deny
                          </button>
                        </>
                      )}
                      {/* Denied: Approve */}
                      {user.account_status === 'denied' && (
                        <button
                          onClick={() => updateAccess(user.id, 'approved')}
                          style={{
                            padding: '4px 12px',
                            borderRadius: '4px',
                            border: 'none',
                            background: '#16a34a',
                            color: '#fff',
                            fontSize: '13px',
                            cursor: 'pointer',
                          }}
                        >
                          Approve
                        </button>
                      )}
                      {/* Approved: Revoke */}
                      {user.account_status === 'approved' && (
                        <button
                          onClick={() => updateAccess(user.id, 'denied')}
                          style={{
                            padding: '4px 12px',
                            borderRadius: '4px',
                            border: 'none',
                            background: '#dc2626',
                            color: '#fff',
                            fontSize: '13px',
                            cursor: 'pointer',
                          }}
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
