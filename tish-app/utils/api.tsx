// utils/api.ts
import { fetchAuthSession } from "@aws-amplify/auth";

// 🚨 CHANGE THIS: It must be your API Gateway URL, not the Lambda URL
const BASE_URL = 'https://u91xzojfja.execute-api.ap-east-2.amazonaws.com/production'; 

interface RequestOptions extends RequestInit {
  body?: any; 
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