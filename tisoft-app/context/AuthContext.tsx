import { apiRequest } from '@/utils/api';
import { fetchAuthSession, signOut } from 'aws-amplify/auth';
import React, { createContext, useContext, useEffect, useState } from 'react';

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
    } catch (e) { console.error(e); }
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
        await signOut();
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
      await signOut();
      setUser(null);
      setToken(null);
      setActiveDependent(null);
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