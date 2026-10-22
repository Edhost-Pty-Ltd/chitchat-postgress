// ─── WebRTC Platform Wrapper ─────────────────────────────────────────────────
// Lazily loads react-native-webrtc on native platforms only.
//
// react-native-webrtc calls `new NativeEventEmitter(WebRTCModule)` at the
// module's top level. If the module is required during app initialization
// (before the native bridge is fully ready), WebRTCModule can be null and
// the NativeEventEmitter throws. Deferring the require() to first-use avoids
// this — by then the bridge is always ready.

import { Platform, NativeModules } from 'react-native';

// ─── Web mocks ───────────────────────────────────────────────────────────────
class MockRTCPeerConnection {
  constructor() {}
  createOffer() { return Promise.resolve({}); }
  createAnswer() { return Promise.resolve({}); }
  setLocalDescription() { return Promise.resolve(); }
  setRemoteDescription() { return Promise.resolve(); }
  addIceCandidate() { return Promise.resolve(); }
  addTrack() { return {}; }
  removeTrack() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

class MockRTCSessionDescription {
  constructor(init: any) { Object.assign(this, init); }
}

class MockRTCIceCandidate {
  constructor(init: any) { Object.assign(this, init); }
}

const mockMediaDevices = {
  getUserMedia: () => Promise.resolve(null),
  enumerateDevices: () => Promise.resolve([]),
};

class MockMediaStream {
  getTracks() { return []; }
  getAudioTracks() { return []; }
  getVideoTracks() { return []; }
  addTrack() {}
  removeTrack() {}
  toURL() { return ''; }
}

// ─── Lazy native loader ───────────────────────────────────────────────────────
// We cache the result so the require only runs once.
let _webrtc: any = null;
function getNative() {
  if (!_webrtc) {
    // require() is deferred to first call — by then the native bridge
    // is fully initialised and WebRTCModule is non-null.
    _webrtc = require('@livekit/react-native-webrtc');
  }
  return _webrtc;
}

// ─── Public API ───────────────────────────────────────────────────────────────
// Each export is a getter that delegates to the real native class on native,
// or the mock on web — without triggering the require at module load time.

export function getRTCPeerConnection() {
  return Platform.OS === 'web' ? MockRTCPeerConnection : getNative().RTCPeerConnection;
}

export function getRTCSessionDescription() {
  return Platform.OS === 'web' ? MockRTCSessionDescription : getNative().RTCSessionDescription;
}

export function getRTCIceCandidate() {
  return Platform.OS === 'web' ? MockRTCIceCandidate : getNative().RTCIceCandidate;
}

export function getMediaDevices() {
  return Platform.OS === 'web' ? mockMediaDevices : getNative().mediaDevices;
}

export function getMediaStream() {
  return Platform.OS === 'web' ? MockMediaStream : getNative().MediaStream;
}

// ─── One-time WebRTC initialization ─────────────────────────────────────────
// Calls registerGlobals() from @livekit/react-native-webrtc. This is REQUIRED
// for audio: it installs the WebRTC globals AND wires up the native audio
// device module's lifecycle listeners (audioDeviceModuleEvents.setupListeners).
// Without it, a call can connect and even deliver video (RTCView pulls the
// video track directly), but the remote AUDIO output device is never managed —
// so you hear nothing. Safe to call multiple times; it's idempotent.
let _globalsRegistered = false;
export function initializeWebRTC(): void {
  if (Platform.OS === 'web' || _globalsRegistered) return;
  try {
    getNative().registerGlobals();
    _globalsRegistered = true;
    console.log('[webrtc-platform] registerGlobals() called — audio device module wired up');
  } catch (err) {
    console.warn('[webrtc-platform] registerGlobals() failed:', err);
  }
}

// ─── In-call audio output routing (loudspeaker vs earpiece) ─────────────────
// Routes the LIVE call audio to the loudspeaker or back to the default route
// (earpiece on iOS voiceChat/videoChat; handset on Android) via a small native
// module (ios/.../AudioRouteModule, android/.../AudioRouteModule).
//
// We deliberately do NOT use expo-audio's setAudioModeAsync for this: that
// reconfigures the shared AVAudioSession category/mode and silences the live
// WebRTC call. The native module only changes the OUTPUT ROUTE:
//   • iOS    → RTCAudioSession.overrideOutputAudioPort(speaker | none)
//   • Android → AudioManager.setSpeakerphoneOn in MODE_IN_COMMUNICATION
// neither of which disturbs WebRTC's audio engine.
export async function setSpeakerphoneOn(enabled: boolean): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const AudioRouteModule = NativeModules.AudioRouteModule;
    if (!AudioRouteModule?.setSpeakerphoneOn) {
      console.warn('[webrtc-platform] AudioRouteModule not available — rebuild the native app');
      return;
    }
    await AudioRouteModule.setSpeakerphoneOn(enabled);
    console.log('[webrtc-platform] Speakerphone set to', enabled);
  } catch (err) {
    console.warn('[webrtc-platform] setSpeakerphoneOn failed:', err);
  }
}

// Legacy named exports for any existing code that imports them directly.
// These still return the correct value but are evaluated lazily on first access
// via a Proxy-like pattern using getters on a plain object.
export const RTCPeerConnection    = new Proxy({} as any, { get: (_, k) => getRTCPeerConnection()[k as string], construct: (_, args) => new (getRTCPeerConnection())(...args) });
export const RTCSessionDescription = new Proxy({} as any, { get: (_, k) => getRTCSessionDescription()[k as string], construct: (_, args) => new (getRTCSessionDescription())(...args) });
export const RTCIceCandidate       = new Proxy({} as any, { get: (_, k) => getRTCIceCandidate()[k as string], construct: (_, args) => new (getRTCIceCandidate())(...args) });
export const mediaDevices          = new Proxy({} as any, { get: (_, k) => getMediaDevices()[k as string] });
export const MediaStream           = new Proxy({} as any, { get: (_, k) => getMediaStream()[k as string], construct: (_, args) => new (getMediaStream())(...args) });

// ─── TypeScript types ─────────────────────────────────────────────────────────
export interface RTCPeerConnectionType {
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  close(): void;
}

export interface MediaStreamType {
  getTracks(): any[];
  getAudioTracks(): any[];
  getVideoTracks(): any[];
  toURL(): string;
}
