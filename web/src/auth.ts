const ADMIN_TOKEN_KEY = 'agenticform.adminToken';

export function getAdminToken(): string | null {
  return window.sessionStorage.getItem(ADMIN_TOKEN_KEY);
}

export function setAdminToken(token: string): void {
  window.sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
}

export function clearAdminToken(): void {
  window.sessionStorage.removeItem(ADMIN_TOKEN_KEY);
}
