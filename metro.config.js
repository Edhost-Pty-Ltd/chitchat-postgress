// ─── Metro Configuration ─────────────────────────────────────────────────────
// Learn more: https://docs.expo.dev/guides/customizing-metro

const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// ─── Web Shims ───────────────────────────────────────────────────────────────
// Redirect native-only packages to lightweight web-compatible shims.
// This prevents requireNativeComponent crashes on web.
const webShims = {
  '@livekit/react-native-webrtc': path.resolve(__dirname, 'src/shims/livekit-react-native-webrtc.web.ts'),
  '@react-native-firebase/app': path.resolve(__dirname, 'src/shims/react-native-firebase-app.web.ts'),
  '@react-native-firebase/auth': path.resolve(__dirname, 'src/shims/react-native-firebase-auth.web.ts'),
  '@react-native-firebase/functions': path.resolve(__dirname, 'src/shims/react-native-firebase-functions.web.ts'),
};

const originalResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Only apply shims when bundling for web
  if (platform === 'web' && webShims[moduleName]) {
    return {
      filePath: webShims[moduleName],
      type: 'sourceFile',
    };
  }
  // Fall back to default resolution
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
