export interface AuthSession {
  token: string;
  refreshToken?: string;
  /** Unix timestamp (seconds) when the access token expires. */
  accessTokenExp?: number;
  user: {
    id?: string | number;
    email?: string;
    firstName?: string;
    lastName?: string;
    tenantId?: string;
    [key: string]: unknown;
  };
}
