// ─── Multi-agent business API ────────────────────────────────────────────────
// Business membership, roster data and face-enrollment grants are handled by
// the Node API. The raw face image bypasses Node and goes straight to the
// Django face service with a short-lived signed grant—never through normal
// media/S3 upload routes or a client-selected target user id.

import { apiClient, type ApiClient } from './client';
import type { ApiResult } from './errors';
import { FACE_API_URL } from '../config/env';
import { createFirebaseTokenSource, getFreshIdToken } from './token';

export type MembershipRole = 'owner' | 'admin' | 'agent';
export type MembershipStatus = 'provisioned' | 'active' | 'disabled' | 'removed';
export type AgentAvailability = 'available' | 'busy' | 'away';
export type AgentFaceEnrollmentStatus = 'not_started' | 'pending' | 'enrolled' | 'failed';

export interface TeamAgent {
  agentId: string;
  firstName: string | null;
  surname: string | null;
  displayName: string;
  /** Returned only to the agent or an owner/admin manager. */
  phoneNumber: string | null;
  role: MembershipRole;
  membershipStatus: MembershipStatus;
  agentStatus: AgentAvailability | null;
  faceEnrollmentStatus: AgentFaceEnrollmentStatus;
  faceEnrolledAt: string | null;
  biometricConsentAt: string | null;
  addedAt: string;
  /** Distinct client chats this agent has assisted with (via internal notes). */
  clientCount: number;
}

export interface TeamBusiness {
  businessId: string;
  name: string;
  ownerId: string;
  agents: string[];
  plan: 'free' | 'pro' | 'enterprise';
  createdAt: string;
  settings: { autoAssign: boolean; routingStrategy: 'round-robin' | 'least-active' | 'manual' };
}

export interface TeamDashboard {
  business: TeamBusiness;
  company: {
    businessName: string;
    ownerDisplayName: string | null;
    industry: string | null;
    about: string | null;
    email: string | null;
    website: string | null;
    operationalHours: string | null;
    address: Record<string, string> | null;
    workSchedule: Record<string, { open: string; close: string }> | null;
    catalogItemCount: number;
    catalogCollectionCount: number;
  };
  viewer: {
    agentId: string;
    role: MembershipRole;
    membershipStatus: MembershipStatus;
    agentStatus: AgentAvailability | null;
    canManageAgents: boolean;
  };
  agents: TeamAgent[];
  summary: {
    totalAgents: number;
    activeAgents: number;
    availableAgents: number;
    enrolledAgents: number;
    /** Distinct client chats with at least one internal note, team-wide. */
    totalClientConversations: number;
  };
}

export interface CreateAgentInput {
  firstName: string;
  surname: string;
  /** Canonical E.164 format, for example +27821234567. */
  phoneNumber: string;
  /** Explicit in-person consent confirmation required by the server. */
  consentConfirmed: true;
}

export interface AgentFaceGrantResponse {
  agent: TeamAgent;
  enrollmentGrant: string;
  enrollmentGrantExpiresAt: string;
  firebaseAccountCreated?: boolean;
  requiresPhoneSignIn?: boolean;
  consentRecordedAt?: string | null;
}

export type AdminAgentFaceEnrollResult =
  | { ok: true; receipt: string; receiptExpiresAt: string }
  | { ok: false; error: string; status: number };

const faceTokenSource = createFirebaseTokenSource();

function faceUrl(path: string): string {
  return `${FACE_API_URL.replace(/\/+$/, '')}${path}`;
}

async function faceAuthHeader(): Promise<Record<string, string>> {
  const token = await getFreshIdToken(faceTokenSource);
  if (!token) throw new Error('Not signed in');
  return { Authorization: `Bearer ${token}` };
}

export function createAgentApi(client: ApiClient = apiClient) {
  return {
    getDashboard: (): Promise<ApiResult<{ dashboard: TeamDashboard }>> =>
      client.get('/businesses/dashboard'),

    getAgent: (businessId: string, agentId: string): Promise<ApiResult<{ agent: TeamAgent }>> =>
      client.get(`/businesses/${encodeURIComponent(businessId)}/agents/${encodeURIComponent(agentId)}`),

    createAgent: (
      businessId: string,
      input: CreateAgentInput,
    ): Promise<ApiResult<AgentFaceGrantResponse>> =>
      client.post(`/businesses/${encodeURIComponent(businessId)}/agents`, input),

    requestFaceGrant: (
      businessId: string,
      agentId: string,
    ): Promise<ApiResult<AgentFaceGrantResponse>> =>
      client.post(
        `/businesses/${encodeURIComponent(businessId)}/agents/${encodeURIComponent(agentId)}/face-enrollment-grant`,
      ),

    completeFaceEnrollment: (
      businessId: string,
      agentId: string,
      receipt: string,
    ): Promise<ApiResult<{ agent: TeamAgent }>> =>
      client.post(
        `/businesses/${encodeURIComponent(businessId)}/agents/${encodeURIComponent(agentId)}/face-enrollment-complete`,
        { receipt },
      ),

    setMyAvailability: (
      businessId: string,
      status: AgentAvailability | null,
    ): Promise<ApiResult<{ agent: TeamAgent }>> =>
      client.put(`/businesses/${encodeURIComponent(businessId)}/me/agent-status`, { status }),
  };
}

/**
 * Register an administrator-assisted agent face.
 *
 * After migrating to @faceaisdk/react-native-face-sdk, the manager's device
 * extracts the 1024-char reference feature locally with ``addFaceByImage`` and
 * forwards only that feature to Django under the signed one-time grant. No raw
 * image reaches the server. The grant authorises the target; no target UID is
 * ever sent from the mobile client. No liveness fields are included — this is
 * an explicitly audited, in-person flow where the business owner/admin
 * assumes responsibility.
 */
export async function enrollAdminAssistedAgentFace(
  grant: string,
  faceFeature?: string | null,
): Promise<AdminAgentFaceEnrollResult> {
  let headers: Record<string, string>;
  try {
    headers = await faceAuthHeader();
  } catch {
    return { ok: false, error: 'not_signed_in', status: 401 };
  }

  const body: Record<string, unknown> = { grant };
  if (faceFeature) body.face_feature = faceFeature;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  let response: Response;
  try {
    response = await fetch(faceUrl('/api/face/admin-register/'), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    return { ok: false, error: 'network_error', status: 0 };
  } finally {
    clearTimeout(timeout);
  }

  let payload: any = {};
  try { payload = await response.json(); } catch { /* ignore malformed body */ }
  if (response.status === 201 && payload?.ok && typeof payload?.receipt === 'string') {
    return { ok: true, receipt: payload.receipt, receiptExpiresAt: payload.receipt_expires_at };
  }
  return { ok: false, error: payload?.error ?? 'agent_enrollment_failed', status: response.status };
}

export const agentApi = createAgentApi();
