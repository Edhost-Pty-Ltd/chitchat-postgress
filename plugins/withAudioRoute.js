/**
 * Local Expo config plugin: withAudioRoute
 *
 * Injects a small native module (AudioRouteModule) on both platforms that
 * routes in-call WebRTC audio between the loudspeaker and the earpiece without
 * touching the AVAudioSession category/mode (which would silence a live call).
 *
 * This keeps the native files working across a clean `expo prebuild` — the
 * committed ios/ and android/ copies are the source of truth, and this plugin
 * re-applies them (and the required registrations) when prebuild regenerates
 * the native projects.
 *
 *   iOS     → ios/ChitChatBusiness/AudioRouteModule.{h,m}
 *             (RTCAudioSession.overrideOutputAudioPort)
 *   Android → android/.../audioroute/AudioRouteModule.kt + AudioRoutePackage.kt
 *             (AudioManager.setSpeakerphoneOn in MODE_IN_COMMUNICATION)
 */
const {
  withXcodeProject,
  withMainApplication,
  withDangerousMod,
  IOSConfig,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const IOS_FILES = ['AudioRouteModule.h', 'AudioRouteModule.m'];

const IOS_SOURCES = {
  'AudioRouteModule.h': `#import <React/RCTBridgeModule.h>

@interface AudioRouteModule : NSObject <RCTBridgeModule>
@end
`,
  'AudioRouteModule.m': `#import "AudioRouteModule.h"

#import <AVFoundation/AVFoundation.h>
#import <React/RCTLog.h>
#import <WebRTC/RTCAudioSession.h>

@implementation AudioRouteModule

RCT_EXPORT_MODULE();

- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
+ (BOOL)requiresMainQueueSetup { return NO; }

RCT_EXPORT_METHOD(setSpeakerphoneOn:(BOOL)enabled
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    RTCAudioSession *session = [RTCAudioSession sharedInstance];
    [session lockForConfiguration];
    NSError *error = nil;
    AVAudioSessionPortOverride override =
        enabled ? AVAudioSessionPortOverrideSpeaker : AVAudioSessionPortOverrideNone;
    BOOL ok = [session overrideOutputAudioPort:override error:&error];
    [session unlockForConfiguration];
    if (ok) {
        resolve(@(enabled));
    } else {
        reject(@"audio_route_error",
               error.localizedDescription ?: @"Failed to override output audio port",
               error);
    }
}

@end
`,
};

const ANDROID_PKG = 'com.edhost.ChitChatBusiness';
const ANDROID_SUBDIR = 'audioroute';

const ANDROID_MODULE_KT = `package ${ANDROID_PKG}.${ANDROID_SUBDIR}

import android.content.Context
import android.media.AudioManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class AudioRouteModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun setSpeakerphoneOn(enabled: Boolean, promise: Promise) {
    try {
      val audioManager =
        reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
      audioManager.isSpeakerphoneOn = enabled
      promise.resolve(enabled)
    } catch (e: Exception) {
      promise.reject("audio_route_error", e.message, e)
    }
  }

  companion object {
    const val NAME = "AudioRouteModule"
  }
}
`;

const ANDROID_PACKAGE_KT = `package ${ANDROID_PKG}.${ANDROID_SUBDIR}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class AudioRoutePackage : ReactPackage {
  override fun createNativeModules(
    reactContext: ReactApplicationContext
  ): List<NativeModule> = listOf(AudioRouteModule(reactContext))

  override fun createViewManagers(
    reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> = emptyList()
}
`;

// ── iOS: write the source files and add them to the Xcode target ────────────
function withAudioRouteIosFiles(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const projectName = cfg.modRequest.projectName;
      const groupDir = path.join(cfg.modRequest.platformProjectRoot, projectName);
      for (const file of IOS_FILES) {
        fs.writeFileSync(path.join(groupDir, file), IOS_SOURCES[file]);
      }
      return cfg;
    },
  ]);
}

function withAudioRouteXcode(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const projectName = cfg.modRequest.projectName;
    // Use Expo's own helper (addBuildSourceFileToGroup) to add the compiled
    // source to the app group + Sources build phase. It resolves the group by
    // name, dedupes, and wires the PBXBuildFile/PBXSourcesBuildPhase entries —
    // avoiding the null-path pitfalls of calling the raw `xcode` lib directly.
    // Paths are RELATIVE to the group (which maps to ios/<projectName>/).
    const relM = `${projectName}/AudioRouteModule.m`;

    IOSConfig.XcodeUtils.ensureGroupRecursively(project, projectName);

    // hasFile stores paths without the group prefix; check both forms.
    const already =
      project.hasFile(relM) || project.hasFile('AudioRouteModule.m');
    if (!already) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath: relM,
        groupName: projectName,
        project,
      });
    }
    // The .h does not need a PBXBuildFile entry; the .m imports it by path and
    // the compiler finds it in the same group directory. Skipping it avoids a
    // second fragile xcode call.
    return cfg;
  });
}

// ── Android: write the Kotlin files and register the package ────────────────
function withAudioRouteAndroidFiles(config) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const pkgPath = ANDROID_PKG.replace(/\./g, '/');
      const dir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'java', pkgPath, ANDROID_SUBDIR,
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'AudioRouteModule.kt'), ANDROID_MODULE_KT);
      fs.writeFileSync(path.join(dir, 'AudioRoutePackage.kt'), ANDROID_PACKAGE_KT);
      return cfg;
    },
  ]);
}

function withAudioRouteMainApplication(config) {
  return withMainApplication(config, (cfg) => {
    let contents = cfg.modResults.contents;
    const importLine = `import ${ANDROID_PKG}.${ANDROID_SUBDIR}.AudioRoutePackage`;

    if (!contents.includes(importLine)) {
      // Insert the import after the package declaration line.
      contents = contents.replace(
        /^(package .*\n)/m,
        `$1${importLine}\n`,
      );
    }

    // Register the package inside the PackageList(this).packages.apply { } block.
    if (!contents.includes('add(AudioRoutePackage())')) {
      contents = contents.replace(
        /(PackageList\(this\)\.packages\.apply\s*\{)/,
        `$1\n          add(AudioRoutePackage())`,
      );
    }

    cfg.modResults.contents = contents;
    return cfg;
  });
}

module.exports = function withAudioRoute(config) {
  config = withAudioRouteIosFiles(config);
  config = withAudioRouteXcode(config);
  config = withAudioRouteAndroidFiles(config);
  config = withAudioRouteMainApplication(config);
  return config;
};
