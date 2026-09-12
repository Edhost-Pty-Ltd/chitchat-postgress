# Bug Report: iOS Build Failure — `expo-av` Incompatible with Expo SDK 57

**Project:** ChitChatBusiness  
**Date:** September 11, 2026  
**Severity:** Build-breaking (app could not compile for iOS)  
**Status:** ✅ Resolved

---

## The Error

When running `expo run:ios`, the build failed with this error:

```
❌  (node_modules/expo-av/ios/EXAV/EXAV.h:10:9)

   8 | #import <ExpoModulesCore/EXAppLifecycleListener.h>
   9 | #import <ExpoModulesCore/EXExportedModule.h>
> 10 | #import <ExpoModulesCore/EXEventEmitter.h>
      |         ^ 'ExpoModulesCore/EXEventEmitter.h' file not found

CommandError: Failed to build iOS project. "xcodebuild" exited with error code 65.
```

The Xcode compiler could not find the header file `EXEventEmitter.h` inside the `ExpoModulesCore` framework.

---

## Root Cause Analysis

### The Version Mismatch

The project was using **Expo SDK 57** but had **`expo-av` version 16.0.8** installed — which is the SDK 56 release of that package.

```json
// package.json (before fix)
"expo": "^57.0.21",   // SDK 57
"expo-av": "^16.0.8"  // ← SDK 56 package — INCOMPATIBLE
```

### Why This Breaks

`expo-av` is a native module. Its iOS source code (`EXAV.h`) was written using the **legacy Expo module architecture**, which relied on a set of Objective-C header files exported by `ExpoModulesCore`:

- `EXExportedModule.h`
- `EXEventEmitter.h`  ← the missing one
- `EXModuleRegistryConsumer.h`
- etc.

In **Expo SDK 57**, the `ExpoModulesCore` package was updated and **the legacy `EXEventEmitter.h` header was removed**. It no longer exists anywhere in the framework.

Because `expo-av` v16 still tried to `#import` that header, the Xcode compiler could not find it and the entire build failed.

### Why `expo-av` v16 Was the Wrong Version

Expo SDK releases are tied to specific package versions:

| Expo SDK | expo-av version |
|----------|----------------|
| SDK 51   | 14.x           |
| SDK 55   | 15.x           |
| SDK 56   | 16.x           |
| SDK 57   | **Deprecated** — replaced by `expo-audio` |

`expo-av` was **officially deprecated** starting with SDK 57. The replacement is `expo-audio`, which uses the modern Expo Modules architecture and is fully compatible with SDK 57's version of `ExpoModulesCore`.

Importantly, `expo-audio ~57.0.4` was **already listed** in the project's `package.json` — it just wasn't being used in the code yet.

---

## What Was Fixed

### 1. Removed `expo-av` from `package.json`

```diff
- "expo-av": "^16.0.8",
```

### 2. Updated the import in `src/screens/CalenderScreen.tsx`

```diff
- import { Audio } from 'expo-av';
+ import { useAudioRecorder, AudioModule, RecordingPresets, setAudioModeAsync } from 'expo-audio';
```

### 3. Refactored the recording state in `ActiveMeetingWorkspace`

The old code stored an `Audio.Recording` object in React state and called methods on it imperatively. The new `expo-audio` API is hook-based — you call `useAudioRecorder()` at the top of the component and it manages the recorder's lifecycle automatically.

**Before (expo-av):**
```tsx
const [recording, setRecording] = useState<Audio.Recording | null>(null);

// Start:
await Audio.requestPermissionsAsync();
await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
const { recording: newRec } = await Audio.Recording.createAsync(
  Audio.RecordingOptionsPresets.HIGH_QUALITY
);
setRecording(newRec);

// Stop:
await recording.stopAndUnloadAsync();
const uri = recording.getURI();
```

**After (expo-audio):**
```tsx
const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

// Start:
const { granted } = await AudioModule.requestRecordingPermissionsAsync();
await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
await audioRecorder.prepareToRecordAsync();
audioRecorder.record();

// Stop:
await audioRecorder.stop();
const uri = audioRecorder.uri;
```

### 4. Ran `npm install` to sync the lockfile

```bash
npm install --legacy-peer-deps
```

Confirmed `expo-av` was fully removed from `node_modules`.

---

## API Migration Reference

| expo-av (old) | expo-audio (new) |
|---|---|
| `Audio.requestPermissionsAsync()` | `AudioModule.requestRecordingPermissionsAsync()` |
| `Audio.setAudioModeAsync({ allowsRecordingIOS, playsInSilentModeIOS })` | `setAudioModeAsync({ allowsRecording, playsInSilentMode })` |
| `Audio.Recording.createAsync(presets)` | `audioRecorder.prepareToRecordAsync()` + `audioRecorder.record()` |
| `Audio.RecordingOptionsPresets.HIGH_QUALITY` | `RecordingPresets.HIGH_QUALITY` |
| `recording.stopAndUnloadAsync()` | `audioRecorder.stop()` |
| `recording.getURI()` | `audioRecorder.uri` (property, not a function) |
| `useState<Audio.Recording \| null>` | `useAudioRecorder(options)` hook |

---

## Files Changed

| File | Change |
|---|---|
| `package.json` | Removed `expo-av` dependency |
| `src/screens/CalenderScreen.tsx` | Updated import + refactored recording logic in `ActiveMeetingWorkspace` |

---

## Key Takeaway

When upgrading Expo SDK versions, **all native module packages must be updated to their matching SDK version**. The `^` version prefix in `package.json` does **not** guarantee SDK compatibility — it only tracks semver. Always check the [Expo SDK changelog](https://expo.dev/changelog) and use `npx expo install` to install the correct versions of packages for your SDK.
