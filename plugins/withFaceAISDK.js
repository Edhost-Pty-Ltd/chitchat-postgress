// ─── Expo config plugin for @faceaisdk/react-native-face-sdk 1.7.4 ──────────
// SDK 1.7.4 autolinks its own podspec and supplies the TensorFlowLite
// modulemap automatically, so the only native work this plugin does is:
//
//   1. iOS Podfile: patch the TensorFlowLiteSwift pod to build with
//      BUILD_LIBRARY_FOR_DISTRIBUTION=YES + -no-verify-emitted-module-interface.
//      The prebuilt FaceAISDK_Core was compiled against TensorFlowLiteSwift's
//      resilient (library-evolution) ABI; without this scoped workaround the
//      app crashes with EXC_BREAKPOINT inside Interpreter.init on first use.
//   2. iOS app target: force BUILD_LIBRARY_FOR_DISTRIBUTION=NO. FaceAISDK_Core
//      exports YES into the app's Pods xcconfig (user_target_xcconfig); the
//      app target has a Swift bridging header, and Swift rejects bridging
//      headers in library-evolution mode ("Using bridging headers with
//      module interfaces is unsupported").
//   3. iOS Info.plist: ensure NSCameraUsageDescription is set.
//   4. Android: ensure the CAMERA permission is declared.
//
// Both iOS workarounds are documented in the SDK's consumer demo README
// (https://github.com/FaceAISDK/FaceRecognition_ReactNative).

const {
  IOSConfig,
  withDangerousMod,
  withInfoPlist,
  withAndroidManifest,
  withXcodeProject,
} = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const CAMERA_TEXT =
  'ChitChat Business needs camera access to verify your identity.';

const PODFILE_TAG = 'faceaisdk-tfl-swift-fix';
const PODFILE_MARK = `# @generated ${PODFILE_TAG}`;
const PODFILE_END = `# @generated end ${PODFILE_TAG}`;

const PODFILE_PATCH = `${PODFILE_MARK}
    # TensorFlowLiteSwift ABI fix required by FaceAISDK_Core 2026.09.22.
    tfl_flag = '-no-verify-emitted-module-interface'
    installer.pods_project.targets.each do |target|
      next unless target.name == 'TensorFlowLiteSwift'
      target.build_configurations.each do |configuration|
        configuration.build_settings['BUILD_LIBRARY_FOR_DISTRIBUTION'] = 'YES'
        existing = Array(configuration.build_settings['OTHER_SWIFT_FLAGS'] || '$(inherited)').join(' ')
        unless existing.split.include?(tfl_flag)
          configuration.build_settings['OTHER_SWIFT_FLAGS'] = "#{existing} #{tfl_flag}"
        end
      end
    end
    ${PODFILE_END}`;

function withPodfileTflFix(config) {
  return withDangerousMod(config, [
    'ios',
    (c) => {
      const podfilePath = path.join(c.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfilePath)) return c;
      let src = fs.readFileSync(podfilePath, 'utf8');

      // Idempotent: strip any previous generation of our block first.
      const re = new RegExp(
        `\\s*${PODFILE_MARK}[\\s\\S]*?${PODFILE_END}`,
        'g',
      );
      src = src.replace(re, '');

      // Insert right after the react_native_post_install(...) call inside
      // the post_install block that Expo prebuild always writes. The call is
      // written across multiple lines and contains a nested (...), so the
      // anchor matches up to the first close-paren on its own line and the
      // trailing newline.
      const anchor = /react_native_post_install\([\s\S]*?\n\s*\)\s*\n/;
      const match = src.match(anchor);
      if (!match) {
        // CocoaPods refuses multiple top-level post_install hooks, so a
        // fallback that writes a second block would break pod install. Fail
        // loudly instead so the mis-fitting Podfile gets attention.
        throw new Error(
          'withFaceAISDK: could not find react_native_post_install(...) in ' +
            'the generated Podfile. The plugin needs to be updated to match ' +
            'the new Expo-generated Podfile shape.',
        );
      }
      src = src.replace(anchor, (m) => `${m}    ${PODFILE_PATCH}\n`);
      fs.writeFileSync(podfilePath, src);
      return c;
    },
  ]);
}

function withAppTargetLibraryEvolutionOff(config) {
  return withXcodeProject(config, (c) => {
    const project = c.modResults;
    const [, target] = IOSConfig.Target.findFirstNativeTarget(project);
    const buildConfigs = IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
      project,
      target.buildConfigurationList,
    );
    // Target-level settings override the Pods xcconfig the target inherits.
    for (const [, buildConfig] of buildConfigs) {
      buildConfig.buildSettings.BUILD_LIBRARY_FOR_DISTRIBUTION = 'NO';
    }
    return c;
  });
}

function withCameraUsage(config) {
  return withInfoPlist(config, (c) => {
    if (!c.modResults.NSCameraUsageDescription) {
      c.modResults.NSCameraUsageDescription = CAMERA_TEXT;
    }
    return c;
  });
}

function withAndroidCameraPermission(config) {
  return withAndroidManifest(config, (c) => {
    const manifest = c.modResults.manifest;
    manifest['uses-permission'] = manifest['uses-permission'] || [];
    const already = manifest['uses-permission'].some(
      (p) => p?.$?.['android:name'] === 'android.permission.CAMERA',
    );
    if (!already) {
      manifest['uses-permission'].push({
        $: { 'android:name': 'android.permission.CAMERA' },
      });
    }
    return c;
  });
}

module.exports = function withFaceAISDK(config) {
  config = withCameraUsage(config);
  config = withAndroidCameraPermission(config);
  config = withPodfileTflFix(config);
  config = withAppTargetLibraryEvolutionOff(config);
  return config;
};
