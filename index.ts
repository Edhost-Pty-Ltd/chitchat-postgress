// MUST be first: neutralizes `new NativeEventEmitter(null)` crashes that some
// native libs trigger at module-eval time before the bridge is ready.
import './src/shims/native-event-emitter-guard';
import 'expo-dev-client';
import { registerRootComponent } from 'expo';
import App from './App';

// Web-specific entry point
registerRootComponent(App);
 