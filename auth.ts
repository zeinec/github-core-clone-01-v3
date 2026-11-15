/** Validate the forge's configured bearer token without accepting header lists. */
export function extractBearerToken(
  value: string | string[] | undefined,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = /^Bearer ([^\s]+)$/i.exec(value);

  if (match === null) {
    return null;
  }

  return match[1];
}

export function isAuthenticated(
  headers: { authorization?: string | string[] },
): boolean {
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN;

  if (typeof expectedToken !== "string" || expectedToken.length === 0) {
    return false;
  }

  const bearerToken = extractBearerToken(headers.authorization);

  return bearerToken === expectedToken;
}
