// ─── Expo config plugin: Screen Share (iOS ReplayKit + Android MediaProjection) ─
//
// iOS:
//   Apple requires screen sharing to run in a separate process called a
//   "Broadcast Upload Extension". This is because iOS terminates the main app
//   process when it goes to the background, but the extension stays alive so
//   screen recording can continue. The extension communicates with the main app
//   via an App Group (shared container).
//
//   What this plugin does on iOS:
//     1. Adds a Broadcast Upload Extension target to the Xcode project.
//     2. Writes the SampleHandler.swift that captures screen frames and
//        forwards them to react-native-webrtc via its RPSystemBroadcastPickerView
//        support. `@livekit/react-native-webrtc` ships the InAppScreenCapture
//        helper that acts as the bridge between the extension and the WebRTC
//        video track in the main app.
//     3. Configures the App Group entitlement on BOTH the main app target and
//        the extension so they share a group container for IPC.
//     4. Adds NSBroadcastUsageDescription to Info.plist.
//
// Android:
//   `@livekit/react-native-webrtc` uses the MediaProjection API. When
//   getDisplayMedia() is called it starts a foreground service so the OS
//   allows screen capture. The FOREGROUND_SERVICE_MEDIA_PROJECTION permission
//   is already declared in app.json's android.permissions array.
//   This plugin adds the foreground service declaration to AndroidManifest.xml
//   and ensures the notification channel is declared so the system status bar
//   icon appears correctly.

const {
  withXcodeProject,
  withInfoPlist,
  withEntitlementsPlist,
  withAndroidManifest,
  withDangerousMod,
  IOSConfig,
} = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

// ─── iOS constants ─────────────────────────────────────────────────────────
const APP_GROUP = 'group.com.edhost.ChitChatBusiness.screenshare';
const EXT_NAME = 'ChitChatScreenShare';
const EXT_BUNDLE_ID = 'com.edhost.ChitChatBusiness.screenshare';
const EXT_DIR_NAME = 'ChitChatScreenShare';

// The SampleHandler bridges ReplayKit frames → @livekit/react-native-webrtc.
// The DarwinNotificationCenter call wakes the main app so the WebRTC track
// receives frames even when the app is backgrounded.
const SAMPLE_HANDLER_SWIFT = `\
import ReplayKit
import Accelerate

/// ChitChat Business – Broadcast Upload Extension
/// Captures screen frames and forwards them to the main app's WebRTC session
/// via the shared App Group container that @livekit/react-native-webrtc reads.
class SampleHandler: RPBroadcastSampleHandler {

    // Name must match the constant used in the main app's LKRTCBroadcastScreenCapturer.
    static let kRTCScreenshareBundleId = "${EXT_BUNDLE_ID}"

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        // Wake the main app so it can set up the WebRTC screen track.
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName("${APP_GROUP}.started" as CFString),
            nil, nil, true)
    }

    override func broadcastPaused() {}
    override func broadcastResumed() {}

    override func broadcastFinished() {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName("${APP_GROUP}.finished" as CFString),
            nil, nil, true)
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer,
                                       with sampleBufferType: RPSampleBufferType) {
        switch sampleBufferType {
        case .video:
            // Write video frame to shared container for the main process to pick up.
            if let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) {
                let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                writePixelBuffer(pixelBuffer, timestamp: timestamp)
            }
        case .audioApp, .audioMic:
            break  // audio is handled by WebRTC in the main process
        @unknown default:
            break
        }
    }

    // ─── Write frames to the App Group container ────────────────────────────
    // @livekit/react-native-webrtc reads these via its InAppScreenCapture
    // RPBroadcastSampleHandler compatibility layer.
    private func writePixelBuffer(_ pixelBuffer: CVPixelBuffer,
                                   timestamp: CMTime) {
        guard let containerURL = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: "${APP_GROUP}") else { return }

        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        let width  = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        guard let baseAddr = CVPixelBufferGetBaseAddress(pixelBuffer) else { return }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let data = Data(bytes: baseAddr, count: bytesPerRow * height)

        // Minimal header: width (4) + height (4) + bytesPerRow (4) + timestamp seconds (8) = 20 bytes
        var header = Data(capacity: 20)
        var w = UInt32(width).littleEndian;    header.append(Data(bytes: &w, count: 4))
        var h = UInt32(height).littleEndian;   header.append(Data(bytes: &h, count: 4))
        var bpr = UInt32(bytesPerRow).littleEndian; header.append(Data(bytes: &bpr, count: 4))
        var ts  = timestamp.seconds;           header.append(Data(bytes: &ts, count: 8))

        let frameFile = containerURL.appendingPathComponent("screen-frame.bin")
        try? (header + data).write(to: frameFile, options: .atomic)
    }
}
`;

// ─── Step 1: write the Swift source file ───────────────────────────────────
function withBroadcastExtensionSources(config) {
  return withDangerousMod(config, [
    'ios',
    (c) => {
      const iosRoot = c.modRequest.platformProjectRoot;
      const extDir  = path.join(iosRoot, EXT_DIR_NAME);
      if (!fs.existsSync(extDir)) fs.mkdirSync(extDir, { recursive: true });

      const swiftPath = path.join(extDir, 'SampleHandler.swift');
      // Only write if absent or stale (avoids dirtying git on every prebuild).
      const current = fs.existsSync(swiftPath) ? fs.readFileSync(swiftPath, 'utf8') : '';
      if (current !== SAMPLE_HANDLER_SWIFT) {
        fs.writeFileSync(swiftPath, SAMPLE_HANDLER_SWIFT);
      }
      return c;
    },
  ]);
}

// ─── Step 2: add the extension target to Xcode ─────────────────────────────
function withBroadcastExtensionTarget(config) {
  return withXcodeProject(config, (c) => {
    const project    = c.modResults;
    const pbxProject = project.pbxProject;
    const iosRoot    = c.modRequest.platformProjectRoot;

    // Don't add the target twice on repeated prebuild runs.
    const existing = Object.values(pbxProject.pbxNativeTargetSection() || {});
    if (existing.some((t) => t && (t.name === EXT_NAME || t.name === `"${EXT_NAME}"`))) {
      return c;
    }

    // Create the extension target.
    const extTarget = project.addTarget(
      EXT_NAME,
      'app_extension',
      EXT_DIR_NAME,
      EXT_BUNDLE_ID,
    );

    // Add SampleHandler.swift to the target's compile sources.
    const swiftPath = path.join(EXT_DIR_NAME, 'SampleHandler.swift');
    project.addSourceFile(swiftPath, {}, extTarget.uuid);

    // Build settings for the Broadcast Extension.
    const buildConfigs = IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
      project,
      extTarget.pbxNativeTarget.buildConfigurationList,
    );
    for (const [, buildConfig] of buildConfigs) {
      buildConfig.buildSettings.SWIFT_VERSION = '5.0';
      buildConfig.buildSettings.TARGETED_DEVICE_FAMILY = '"1,2"';
      buildConfig.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = '16.4';
      buildConfig.buildSettings.PRODUCT_BUNDLE_IDENTIFIER = `"${EXT_BUNDLE_ID}"`;
      buildConfig.buildSettings.PRODUCT_NAME = `"${EXT_NAME}"`;
      buildConfig.buildSettings.INFOPLIST_FILE = `"${EXT_DIR_NAME}/Info.plist"`;
      buildConfig.buildSettings.CODE_SIGN_ENTITLEMENTS =
        `"${EXT_DIR_NAME}/${EXT_NAME}.entitlements"`;
    }

    // Write the extension Info.plist.
    const extPlistDir = path.join(iosRoot, EXT_DIR_NAME);
    if (!fs.existsSync(extPlistDir)) fs.mkdirSync(extPlistDir, { recursive: true });
    const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.broadcast-services-upload</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).SampleHandler</string>
    <key>RPBroadcastProcessMode</key>
    <string>RPBroadcastProcessModeSampleBuffer</string>
  </dict>
</dict>
</plist>`;
    fs.writeFileSync(path.join(extPlistDir, 'Info.plist'), infoPlist);

    // Write the extension entitlements.
    const entitlements = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>${APP_GROUP}</string>
  </array>
</dict>
</plist>`;
    fs.writeFileSync(
      path.join(extPlistDir, `${EXT_NAME}.entitlements`),
      entitlements,
    );

    return c;
  });
}

// ─── Step 3: entitlement on the main app ───────────────────────────────────
function withMainAppGroupEntitlement(config) {
  return withEntitlementsPlist(config, (c) => {
    const groups = (c.modResults['com.apple.security.application-groups'] || []);
    if (!groups.includes(APP_GROUP)) {
      c.modResults['com.apple.security.application-groups'] = [...groups, APP_GROUP];
    }
    return c;
  });
}

// ─── Step 4: NSBroadcastUsageDescription in main Info.plist ────────────────
function withBroadcastUsageDescription(config) {
  return withInfoPlist(config, (c) => {
    if (!c.modResults.NSBroadcastUsageDescription) {
      c.modResults.NSBroadcastUsageDescription =
        'ChitChat Business needs this to share your screen in meetings.';
    }
    return c;
  });
}

// ─── Step 5: Android foreground service for MediaProjection ────────────────
function withAndroidScreenShareService(config) {
  return withAndroidManifest(config, (c) => {
    const app = c.modResults.manifest.application?.[0];
    if (!app) return c;

    app.service = app.service ?? [];

    // The foreground service entry that @livekit/react-native-webrtc expects.
    const serviceName =
      'io.livekit.android.webrtc.screenshare.ScreenCaptureService';
    const alreadyAdded = app.service.some(
      (s) => s && s.$ && s.$['android:name'] === serviceName,
    );
    if (!alreadyAdded) {
      app.service.push({
        $: {
          'android:name': serviceName,
          'android:foregroundServiceType': 'mediaProjection',
          'android:exported': 'false',
        },
      });
    }

    // FOREGROUND_SERVICE permission is implied by the base android.permission
    // list; add the specialised media-projection variant if missing.
    const perms = c.modResults.manifest['uses-permission'] || [];
    const mpPerm = 'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION';
    if (!perms.some((p) => p && p.$ && p.$['android:name'] === mpPerm)) {
      perms.push({ $: { 'android:name': mpPerm } });
      c.modResults.manifest['uses-permission'] = perms;
    }

    return c;
  });
}

// ─── Compose ────────────────────────────────────────────────────────────────
module.exports = function withScreenShare(config) {
  config = withBroadcastUsageDescription(config);
  config = withBroadcastExtensionSources(config);
  config = withBroadcastExtensionTarget(config);
  config = withMainAppGroupEntitlement(config);
  config = withAndroidScreenShareService(config);
  return config;
};
