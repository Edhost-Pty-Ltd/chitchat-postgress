// ─── NativeEventEmitter null-argument guard ──────────────────────────────────
// Some native-backed libraries (e.g. @livekit/react-native-webrtc) construct
// `new NativeEventEmitter(SomeNativeModule)` at module top-level. During app
// startup — before the native bridge / TurboModules are fully ready — that
// module can be null, and NativeEventEmitter throws:
//
//   Invariant Violation: `new NativeEventEmitter()` requires a non-null argument.
//
// That throw aborts the JS entry point, so the app shows "App entry not found"
// and never boots.
//
// Libraries read NativeEventEmitter from different places:
//   • `require('react-native').NativeEventEmitter`
//   • `require('react-native/Libraries/EventEmitter/NativeEventEmitter')`
// and the RN index re-export can be a frozen getter we can't override. So we
// patch the ACTUAL class at its source module (the deep path) by wrapping its
// prototype's internal setup to never throw on a null/undefined argument.
//
// Import this as the VERY FIRST line of the app entry (index.ts).

/* eslint-disable @typescript-eslint/no-var-requires */

function makeStubModule() {
  return { addListener: () => {}, removeListeners: () => {} };
}

try {
  // The real class lives here; this is what the RN index re-exports.
  const NEEModule = require('react-native/Libraries/EventEmitter/NativeEventEmitter');
  const RealNEE = NEEModule.default ?? NEEModule;

  if (RealNEE && RealNEE.prototype && !RealNEE.__nullArgGuardInstalled) {
    // Wrap the constructor by intercepting at the prototype level is not enough
    // (the invariant runs in the constructor body). Instead, override the
    // module's exported class with a subclass that fills in a stub module.
    class GuardedNativeEventEmitter extends RealNEE {
      constructor(nativeModule?: any, ...rest: any[]) {
        super(nativeModule ?? makeStubModule(), ...rest);
      }
    }
    (GuardedNativeEventEmitter as any).__nullArgGuardInstalled = true;

    // Replace both the default and the module-level export so every import
    // path picks up the guarded class.
    try { NEEModule.default = GuardedNativeEventEmitter; } catch {}
    try { module.exports = GuardedNativeEventEmitter; } catch {}
    try {
      Object.defineProperty(NEEModule, 'default', {
        configurable: true, writable: true, value: GuardedNativeEventEmitter,
      });
    } catch {}

    // Also swap it on the react-native index in case something reads it there
    // after this point.
    try {
      const RN = require('react-native');
      Object.defineProperty(RN, 'NativeEventEmitter', {
        configurable: true, writable: true, value: GuardedNativeEventEmitter,
      });
    } catch {}
  }
} catch (err) {
  console.warn('[native-event-emitter-guard] could not install guard:', err);
}
