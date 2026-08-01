import { apiRequest } from '@/utils/api';
import { unregisterPushToken } from '@/utils/push-token';
import { cacheOwnerNames } from '@/utils/reminder-store';
import { fetchAuthSession, signOut } from 'aws-amplify/auth';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

import AsyncStorage from '@react-native-async-storage/async-storage';

// 1. User Profile Shape
interface User {
  id: number;
  username: string;
  email: string;
  role: string;
  full_name?: string;
  phone_number?: string;
  birth_date?: string;
  gender_id?: number;
  condition_id?: number;
}

// 2. Updated Interface: This MUST match what you put in the <AuthContext.Provider value={...}>
interface AuthContextType {
  user: User | null;
  token: string | null;          // Added
  isLoading: boolean;
  activeDependent: User | null;
  login: (userData: User) => void;
  logout: () => void;
  checkUser: () => Promise<void>; // Added
  dependents: User[];
  loadDependents: () => Promise<void>;
  setActiveDependent: (user: User | null) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/** The scope a previous session was viewing. 3.3 both writes and validates it. */
const ACTIVE_DEPENDENT_KEY = 'active_dependent';

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [activeDependent, setActiveDependent] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Inside AuthProvider component
  const [dependents, setDependents] = useState<User[]>([]);


  /**
   * 3.3 — reloads the dependent list and **revalidates the selected scope
   * against it.**
   *
   * The selected dependent is the answer to "whose records am I looking at",
   * and until now nothing ever rechecked that the relationship behind it still
   * existed. After 3.2 that gap is reachable on purpose: a dependent revokes
   * consent on their own device, and the caregiver's app carries on showing
   * their name in the header and requesting their data until some route happens
   * to 403.
   *
   * **Cleared only on a definite answer.** A failed request leaves the scope
   * alone — the server enforces access on every route regardless (`checkAccess`
   * filters on `status = 'active'`), so a stale client scope discloses nothing;
   * it only produces errors. Dropping the user out of a dependent's records
   * every time the network hiccups would be a worse trade.
   */
  const loadDependents = useCallback(async () => {
    try {
      const res = await apiRequest('/my-dependents');
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data)) return;

      setDependents(data);
      // 4.2 — persist the names so an alarm that cold-starts the app can say
      // whose dose it is. This is the only place the app already has dependent
      // names in hand, and doing it here keeps the alarm path off the network.
      await cacheOwnerNames(data);

      setActiveDependent((current) => {
        if (!current) return current;
        if (data.some((d: User) => Number(d.id) === Number(current.id))) return current;
        console.info('[auth] active dependent', current.id, 'is no longer accessible — clearing scope');
        AsyncStorage.removeItem(ACTIVE_DEPENDENT_KEY).catch(() => {});
        return null;
      });
    } catch (e) { console.error(e); }
  }, []);

  /**
   * --- PERSISTENCE LOGIC: SAVE ON CHANGE ---
   *
   * **This was written and then never wired up.** The context exposed the raw
   * `setActiveDependent` state setter instead, so nothing ever wrote the key and
   * nothing ever read it back — which meant 3.3's premise ("`activeDependent` is
   * restored from AsyncStorage without checking the relationship still exists")
   * described a restore that did not happen. Validating a scope that never loads
   * would have been a no-op, so the fix is both halves: make the persistence
   * real, and check it before trusting it.
   */
  const updateActiveDependent = useCallback(async (dep: User | null) => {
    setActiveDependent(dep);
    try {
      if (dep) await AsyncStorage.setItem(ACTIVE_DEPENDENT_KEY, JSON.stringify(dep));
      else await AsyncStorage.removeItem(ACTIVE_DEPENDENT_KEY);
    } catch (e) {
      // The scope is already set in memory; losing the persistence costs a
      // reset to "self" on the next launch, not a broken session.
      console.warn('[auth] could not persist the active dependent', e);
    }
  }, []);

  /**
   * Restores the scope a previous session was in.
   *
   * **Deliberately restored *before* `/my-dependents` answers, and cleared
   * afterwards if it turns out to be stale.** Waiting for the round trip would
   * flash the caregiver's own records on every cold start. The window is real
   * but harmless: every request in it is scoped server-side, so the worst
   * outcome is a screen that briefly asks for data it is about to be told it
   * cannot have.
   */
  const restoreActiveDependent = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(ACTIVE_DEPENDENT_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && Number.isFinite(Number(saved.id))) setActiveDependent(saved);
    } catch {
      await AsyncStorage.removeItem(ACTIVE_DEPENDENT_KEY).catch(() => {});
    }
  }, []);

  const checkUser = async () => {
    // 1. Keep isLoading = true throughout the whole process
    try {
      const session = await fetchAuthSession();
      const idToken = session.tokens?.idToken;

      console.log("Fetched Cognito session:", session);

      if (!idToken) {
        setUser(null);
        setToken(null);
        return;
      }
      const jwtString = idToken.toString();
      console.log("Cognito session found. JWT:", jwtString);
      setToken(jwtString);

      // 2. Instead of setting the user twice, fetch the RDS data first
      // We use a temporary variable so the UI doesn't see the "basic" user
      const res = await apiRequest('/me');
      // 3.3 — restore the persisted scope, then let `loadDependents` confirm or
      // clear it. Neither is awaited: the profile fetch below is what the UI is
      // waiting on, and both of these correct themselves a moment later.
      restoreActiveDependent();
      loadDependents();

      if (res.ok) {
        const rdsProfile = await res.json();
        console.log("RDS Profile fetched successfully:", rdsProfile);
        setUser(rdsProfile); // ✅ SET USER ONCE (The Final Truth)
      } else {
        console.error("RDS Profile missing for this Cognito user");
        console.error("User verified in Cognito but not found in RDS.");
        //await signOut();
        //setToken(null);
        //setUser(null); // Or keep basic user if you prefer
        const claims = idToken.payload;
        setUser({
          id: 0,
          username: (claims['preferred_username'] as string) || (claims['email'] as string),
          email: claims.email as string,
          isProfileComplete: false, // Flag for the router
        } as any);
      }
    } catch (e) {
      console.error("Error checking user session:", e);
      setUser(null);
      setToken(null);
    } finally {
      // 3. ONLY NOW tell the app we are done loading
      setIsLoading(false);
    }
  };

  useEffect(() => {
    checkUser();
  }, []);

  const login = (userData: User) => {
    setUser(userData);
    // Token is handled by checkUser() after Amplify signIn
  };

  const logout = async () => {
    try {
      // 5.8 — before `signOut()`, because unregistering needs the session's
      // token to authenticate. Awaited but never fatal: a push token outlives
      // the session, so leaving one behind means the previous user's caregiver
      // escalations keep arriving on a phone somebody else may now be holding.
      // That is a disclosure rather than an untidy row, which is why it is worth
      // the round trip on a path that would otherwise be instant.
      await unregisterPushToken();
      await signOut();
      setUser(null);
      setToken(null);
      setActiveDependent(null);
      setDependents([]);
      await AsyncStorage.multiRemove(['user_session', ACTIVE_DEPENDENT_KEY]);
    } catch (e) {
      console.error("Logout error", e);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isLoading,
        activeDependent,
        login,
        logout,
        checkUser,
        dependents,
        loadDependents,
        // 3.3 — the persisting version, not the bare state setter. The bare one
        // was what the context exposed until now, which is why `active_dependent`
        // was never written by anything.
        setActiveDependent: updateActiveDependent
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};