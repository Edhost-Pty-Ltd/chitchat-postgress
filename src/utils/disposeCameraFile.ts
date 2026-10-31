import { Platform } from 'react-native';
import { File } from 'expo-file-system';

/**
 * Delete a temporary camera capture from Expo's cache.
 *
 * Expo SDK 57's CameraView returns a temporary local URI on native platforms;
 * dropping the URI from React state does not delete the underlying biometric
 * image. Deletion is best-effort because an OS cache purge may win the race.
 */
export function disposeCameraFile(uri: string | null | undefined): void {
  if (!uri || Platform.OS === 'web' || !uri.startsWith('file://')) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Already gone or inaccessible — either way there is nothing else the app
    // can safely do. Never log the biometric file path.
  }
}

export function disposeCameraFiles(uris: Iterable<string>): void {
  for (const uri of uris) disposeCameraFile(uri);
}
