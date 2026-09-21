// ─── Call-Related Types ──────────────────────────────────────────────────────

export type CallStatus = 
  | 'ringing'    // Call initiated, waiting for answer
  | 'accepted'   // Call accepted, connecting
  | 'connected'  // Call active
  | 'ended'      // Call ended normally
  | 'rejected'   // Call rejected by callee
  | 'missed'     // Call not answered
  | 'busy'       // Callee is busy
  | 'failed';    // Call failed (network, etc.)

export type CallType = 'audio' | 'video';

export type CallDirection = 'incoming' | 'outgoing';

export interface CallParticipant {
  userId: string;
  displayName: string;
  photoUrl: string | null;
}

export interface Call {
  callId: string;
  caller: CallParticipant;
  callee: CallParticipant;
  status: CallStatus;
  type: CallType;
  startTime: Date | null;
  endTime: Date | null;
  duration: number | null; // seconds
  
  // WebRTC signaling data
  offer: RTCSessionDescriptionInit | null;
  answer: RTCSessionDescriptionInit | null;
  callerIceCandidates: RTCIceCandidateInit[];
  calleeIceCandidates: RTCIceCandidateInit[];
  
  createdAt: Date;
  updatedAt: Date;
}

export interface CallHistoryItem {
  callId: string;
  otherParty: CallParticipant;
  type: CallType;
  direction: CallDirection;
  status: 'completed' | 'missed' | 'rejected' | 'busy' | 'failed';
  duration: number | null; // seconds
  timestamp: Date;
}

export interface IncomingCallData {
  callId: string;
  caller: CallParticipant;
  type: CallType;
}

// WebRTC configuration
export interface RTCConfig {
  iceServers: RTCIceServer[];
}

// Call state for context
export interface CallState {
  activeCallId: string | null;
  incomingCall: IncomingCallData | null;
  callStatus: CallStatus | null;
  isMuted: boolean;
  isSpeakerOn: boolean;
  callDuration: number; // seconds
} 