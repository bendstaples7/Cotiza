import type { AdvisorMode, ApprovalMode } from './enums';

/** Authenticated Chicago Reno team member */
export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  lastActiveAt: Date;
}

/** Per-user platform settings */
export interface UserSettings {
  id: string;
  userId: string;
  advisorMode: AdvisorMode;
  approvalMode: ApprovalMode;
  /** When true, quote generation will calculate material prices using
   *  the predefined formula instead of using the catalog's unit price directly. */
  materialPriceMode: boolean;
  updatedAt: Date;
}

/** Team member for Personal Brand content type */
export interface TeamMember {
  id: string;
  name: string;
  role: string;
  bioSnippet: string;
  photoMediaId?: string;
  createdAt: Date;
}
