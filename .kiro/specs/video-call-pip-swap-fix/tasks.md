# Implementation Plan

- [x] 1. Verify PipTile animation→swap wiring
  - Confirmed that `PipTile.handleTap` already passes `onTap` as the completion callback to `Animated.sequence().start(onTap)`.
  - Confirmed that `VideoCallScreen` passes `() => swapToMain(p.id)` as the `onTap` prop to each `PipTile`.
  - Confirmed that `swapToMain` correctly swaps `participants[idx]` with `participants[0]` via functional `setParticipants`.
  - All Requirement 3 (Animation-Callback Coordination) criteria are satisfied by the current implementation.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

- [x] 2. Verify swap state management
  - `swapToMain` guards against idx <= 0 (Requirement 2.2).
  - `swapToMain` guards against unknown IDs via `findIndex` returning -1 (Requirement 7.1).
  - Creates new array via spread before swapping (Requirement 2.3).
  - Functional `setParticipants` update ensures correct state without stale closures (Requirement 2.6).
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 7.1, 7.2, 7.3_

- [x] 3. Checkpoint — all PiP swap requirements satisfied
  - The PiP swap functionality was already correctly implemented in VideoCallScreen.
  - No code changes were required for this spec.
