// ─── Team Inbox Context ───────────────────────────────────────────────────────
// Provides team/agent identity resolution for all screens.
//
// For the business OWNER: ownerUid === their own uid, role = 'owner'
// For an AGENT:           ownerUid = the owner's uid, role = 'admin' | 'agent'
// For an unrelated user:  ownerUid = null, role = null (team inbox hidden)

import React, {
  createContext, useContext, useMemo,
} from 'react';
import { useAuth }              from './AuthContext';
import { useOwnerUidForAgent }  from '../hooks/useTeamInbox';
import { useTeamAgents }        from '../hooks/useTeamAgents';
import { TeamAgent }            from '../types';

interface TeamInboxContextValue {
  /** The business owner UID whose inbox we operate on */
  ownerUid:       string | null;
  /** The current user's resolved role within the team */
  role:           'owner' | 'admin' | 'agent' | null;
  /** True if the current user is the business owner */
  isOwner:        boolean;
  /** True if admin OR owner */
  isAdmin:        boolean;
  /** Current user's agent profile (null for the owner themselves) */
  myAgentProfile: TeamAgent | null;
  /** All agents on the team (real-time) */
  agents:         TeamAgent[];
  agentsLoading:  boolean;
  /** True once all identity checks are complete */
  ready:          boolean;
}

const TeamInboxContext = createContext<TeamInboxContextValue>({
  ownerUid:       null,
  role:           null,
  isOwner:        false,
  isAdmin:        false,
  myAgentProfile: null,
  agents:         [],
  agentsLoading:  true,
  ready:          false,
});

export function TeamInboxProvider({ children }: { children: React.ReactNode }) {
  const { userId } = useAuth();

  // Resolve whether current user is owner or agent
  const { ownerUid: resolvedOwnerUid, role: rawRole, loading: roleLoading } =
    useOwnerUidForAgent(userId);

  // If role === 'owner', ownerUid is null from the hook — the owner IS the business
  const ownerUid = rawRole === 'owner' ? userId : resolvedOwnerUid;

  const isOwner = rawRole === 'owner';
  const isAdmin = rawRole === 'owner' || rawRole === 'admin';

  // Load the agent list (real-time)
  const { agents, loading: agentsLoading } = useTeamAgents(ownerUid);

  const myAgentProfile = useMemo(
    () => agents.find((a) => a.uid === userId) ?? null,
    [agents, userId],
  );

  const value = useMemo<TeamInboxContextValue>(() => ({
    ownerUid,
    role:           rawRole,
    isOwner,
    isAdmin,
    myAgentProfile,
    agents,
    agentsLoading,
    ready:          !roleLoading,
  }), [ownerUid, rawRole, isOwner, isAdmin, myAgentProfile, agents, agentsLoading, roleLoading]);

  return (
    <TeamInboxContext.Provider value={value}>
      {children}
    </TeamInboxContext.Provider>
  );
}

export function useTeamInbox() {
  return useContext(TeamInboxContext);
}
