// Web shim for @livekit/react-native-webrtc
// On web, WebRTC is handled by the browser natively; this prevents import errors.
export const RTCPeerConnection = (globalThis as any).RTCPeerConnection ?? class {};
export const RTCSessionDescription = (globalThis as any).RTCSessionDescription ?? class {};
export const RTCIceCandidate = (globalThis as any).RTCIceCandidate ?? class {};
export const mediaDevices = (typeof navigator !== 'undefined' && navigator.mediaDevices) || { getUserMedia: () => Promise.resolve(null) };
export const MediaStream = (globalThis as any).MediaStream ?? class {};
export const RTCView = () => null;
export const registerGlobals = () => {};
