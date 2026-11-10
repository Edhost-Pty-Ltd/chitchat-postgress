// ─── Metro Configuration ─────────────────────────────────────────────────────
// Learn more: https://docs.expo.dev/guides/customizing-metro

const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// ─── Block server directory ───────────────────────────────────────────────────
// The `server/` folder is a Node.js-only backend. Its node_modules contain
// packages like bullmq that use dynamic import() which Metro cannot transform.
// Excluding the whole directory prevents Metro from crawling into it at all.
const serverDir = path.resolve(__dirname, 'server');
config.resolver.blockList = [
  // Block the entire server directory tree (source + its own node_modules)
  new RegExp(`^${serverDir.replace(/[/\\]/g, '[/\\\\]')}[/\\\\].*`),
  // Also block any face_recognition_feat Python directory
  new RegExp(`^${path.resolve(__dirname, 'face_recognition_feat').replace(/[/\\]/g, '[/\\\\]')}[/\\\\].*`),
];

// ─── Web Shims ───────────────────────────────────────────────────────────────
// Redirect native-only packages to lightweight web-compatible shims on web.
const webShims = {
  '@livekit/react-native-webrtc': path.resolve(__dirname, 'src/shims/livekit-react-native-webrtc.web.ts'),
  // Firebase is Auth-only (identity provider). On web, map the RN Firebase auth
  // module to the firebase/auth JS SDK shim. No app/firestore/storage shims are
  // needed — the web build imports firebase/app directly in src/config/firebase.ts.
  '@react-native-firebase/auth':  path.resolve(__dirname, 'src/shims/react-native-firebase-auth.web.ts'),
};

// ─── Native Stubs ────────────────────────────────────────────────────────────
// Packages that are browser-only or removed but still referenced in source.
// Stubs live in src/stubs/ so they survive npm install.
// Registered in both extraNodeModules (project-root context) and resolveRequest
// (all contexts including imports originating from inside node_modules).
const nativeStubMap = {
  'mediasoup-client':             path.resolve(__dirname, 'src/stubs/mediasoup-client.js'),
  'react-native-webrtc-web-shim': path.resolve(__dirname, 'src/stubs/react-native-webrtc-web-shim.js'),
  'hls.js':                       path.resolve(__dirname, 'src/stubs/hls.js'),
  'mediasfu-reactjs':             path.resolve(__dirname, 'src/stubs/mediasfu-reactjs.js'),
};

// ─── Native Aliases ──────────────────────────────────────────────────────────
// Map bare package names to their actual installed location.
// react-native-webrtc → @livekit/react-native-webrtc (LiveKit fork)
const liverkitWebrtcMain = path.resolve(__dirname, 'node_modules/@livekit/react-native-webrtc/lib/commonjs/index.js');
const nativeAliasMap = {
  'react-native-webrtc':          liverkitWebrtcMain,
  '@livekit/react-native-webrtc': liverkitWebrtcMain,
};

// extraNodeModules covers project-root resolution contexts.
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  ...nativeStubMap,
  ...nativeAliasMap,
};

const originalResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Web shims — only on web
  if (platform === 'web' && webShims[moduleName]) {
    return { filePath: webShims[moduleName], type: 'sourceFile' };
  }

  // Native aliases — redirect to the real installed package directory.
  if (platform !== 'web' && Object.prototype.hasOwnProperty.call(nativeAliasMap, moduleName)) {
    return { filePath: nativeAliasMap[moduleName], type: 'sourceFile' };
  }

  // Native stubs — intercept before Metro tries node_modules.
  // Covers ALL contexts including imports from inside node_modules.
  // Do NOT use context.resolveRequest as fallback — it re-enters this function.
  if (platform !== 'web' && Object.prototype.hasOwnProperty.call(nativeStubMap, moduleName)) {
    return { filePath: nativeStubMap[moduleName], type: 'sourceFile' };
  }

  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
