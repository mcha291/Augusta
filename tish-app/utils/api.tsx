// utils/api.ts
import { fetchAuthSession } from "@aws-amplify/auth";
import { API_BASE_URL as BASE_URL } from "../constants/config";

interface RequestOptions extends Omit<RequestInit, 'body'> {
  /**
   * A plain object — this function serialises it for you. Do **not**
   * pre-stringify.
   *
   * Typed as `object` rather than `any` deliberately. Two callers used to pass
   * `JSON.stringify(...)` here, which got serialised a second time; the
   * server's JSON.parse then yielded a *string*, `payload.id` was `undefined`,
   * node-postgres coerced that to NULL, and `DELETE ... WHERE id = NULL`
   * deleted nothing while returning 200 {"message":"Deleted"}. The narrower
   * type makes that a compile error instead of a silent no-op.
   */
  body?: object;
}

export const apiRequest = async (
  endpoint: string,
  options: RequestOptions = {},
  targetUserId?: number
) => {
  const { method = 'GET', body, headers, ...rest } = options;

  let token: string | undefined;
  try {
    const session = await fetchAuthSession();
    // Use idToken for REST API Authorizers
    token = session.tokens?.idToken?.toString();
    //console.log("Fetched token:", token);
  } catch (e) {
    console.log("No active session found");
  }

  // Ensure leading slash for endpoint
  const safeEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  let url = endpoint.startsWith('http') ? endpoint : `${BASE_URL}${safeEndpoint}`;
  
  // Only append if targetUserId is a valid number
  if (typeof targetUserId === 'number') {
    url += (url.includes('?') ? '&' : '?') + `user_id=${targetUserId}`;
  }

  const config: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      // REST API Gateway expects the raw JWT in the header
      ...(token ? { 'Authorization': token } : {}), 
      ...options.headers,
    },
    ...rest,
  };

  if (body) {
    config.body = JSON.stringify(body);
  }

  return fetch(url, config);
};