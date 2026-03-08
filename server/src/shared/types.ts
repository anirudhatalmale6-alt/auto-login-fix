// Shared DTOs for session management

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
}

export interface CandidateSession {
  candidateId: string;
  accessToken: string;
  cookies: Cookie[];
  csrf?: string;
  updatedAt: number;
  expiresAt?: number;
}

export interface SessionSummary {
  candidateId: string;
  updatedAt: number;
  expiresAt?: number;
  pausedUntil?: number | null;
  status: 'active' | 'paused' | 'expired';
}

export interface BootstrapRequest {
  candidateId: string;
  accessToken: string;
  cookies: Cookie[];
  csrf?: string;
}

export interface SessionEvent {
  type: 'session:upsert' | 'session:expire' | 'session:pause' | 'session:resume';
  candidateId: string;
  timestamp: number;
  pausedUntil?: number;
}



