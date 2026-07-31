import { apiRequest } from '@/utils/api';
import { unregisterPushToken } from '@/utils/push-token';
import { cacheOwnerNames } from '@/utils/reminder-store';
import { fetchAuthSession, signOut } from 'aws-amplify/auth';
import React, { createContext, useContext, useEffect, useState } from 'react';

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

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [activeDependent, setActiveDependent] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Inside AuthProvider component
  const [dependents, setDependents] = useState<User[]>([]);


  const loadDependents = async () => {
    try {
      const res = await apiRequest('/my-dependents');
      const data = await res.json();
      setDependents(Array.isArray(data) ? data : []);
      // 4.2 — persist the names so an alarm that cold-starts the app can say
      // whose dose it is. This is the only place the app already has dependent
      // names in hand, and doing it here keeps the alarm path off the network.
      if (Array.isArray(data)) await cacheOwnerNames(data);
    } catch (e) { console.error(e); }
  };

  // --- PERSISTENCE LOGIC: SAVE ON CHANGE ---
  const updateActiveDependent = async (dep: User | null) => {
    setActiveDependent(dep);
    if (dep) {
      // Save to phone's hard drive
      await AsyncStorage.setItem('active_dependent', JSON.stringify(dep));
    } else {
      // Clear from phone's hard drive
      await AsyncStorage.removeItem('active_dependent');
    }
  };

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
      await AsyncStorage.multiRemove(['user_session', 'active_dependent']);
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
        setActiveDependent
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