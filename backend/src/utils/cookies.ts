/**
 * One cookie reader for the request paths that need one.
 *
 * `authMiddleware` and the public `/auth` routes both have to read the login
 * session cookie, and the board runs no cookie-parser middleware. Two copies
 * of the same parsing loop is exactly how one of them ends up decoding a value
 * the other does not, so it lives here once.
 */
export function readCookie(header: string | undefined, name: string): string {
  for (const part of (header || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}
