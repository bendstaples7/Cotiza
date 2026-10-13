/**
 * Who may change the one shared Jobber connection.
 *
 * The company uses a single Jobber account (one token row, one cookie row).
 * This app has no admin role. Sign-in already creates sessions only for
 * @chicago-reno.com addresses, and the recovery screens are shown to every
 * signed-in person. Those people may start authorization, replace cookies,
 * or trigger a cookie refresh.
 *
 * The background "system" user is not a person and may not manage it.
 */
export function canManageSharedJobberConnection(user: { id: string; email: string }): boolean {
  if (!user?.id || user.id === 'system') return false;
  const email = (user.email || '').trim().toLowerCase();
  return email.endsWith('@chicago-reno.com');
}
