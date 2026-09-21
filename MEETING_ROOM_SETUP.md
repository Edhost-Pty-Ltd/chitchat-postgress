# Meeting Room Setup Guide

## Current Fix
The navigation error has been fixed by routing meetings to the `VideoCall` screen instead of the non-existent `MeetingRoom` screen.

## What Changed in CalendarScreen
```typescript
// Before (BROKEN):
(navigation as any).navigate('MeetingRoom', { ... });

// After (FIXED):
(navigation as any).navigate('VideoCall', {
  callId: meeting.id,
  isOutgoing: meeting.organizerId === user.uid,
  otherParty: {
    userId: firstParticipant,
    displayName: meeting.title,
    photoUrl: null,
  },
});
```

## Current Limitation
The `VideoCall` screen is currently designed for 1-on-1 calls, not multi-party meetings. 

When you join a meeting with multiple participants, it will only connect to the first participant found.

## To Add Proper Multi-Party Meeting Support

### Option 1: Enhance VideoCall Screen
Modify the existing `VideoCall` screen to handle multiple participants:
1. Accept an array of participants instead of a single `otherParty`
2. Update the UI to show multiple video tiles
3. Handle multiple WebRTC peer connections

### Option 2: Create a Dedicated MeetingRoom Screen

**Step 1: Create the screen file**
```bash
touch src/screens/MeetingRoomScreen.tsx
```

**Step 2: Add to navigation types** (`src/types/index.ts`)
```typescript
export type RootStackParamList = {
  // ... existing screens
  MeetingRoom: { 
    meetingId: string;
    title: string;
    participants: string[];
    isOrganizer: boolean;
  };
};
```

**Step 3: Register in AppNavigator** (`src/navigation/AppNavigator.tsx`)
```typescript
// Add lazy import
const MeetingRoomScreen = lazy(() => import('../screens/MeetingRoomScreen'));

// Add to Stack.Navigator
<Stack.Screen 
  name="MeetingRoom" 
  component={MeetingRoomScreen as any} 
  options={modalOptions} 
/>
```

**Step 4: Revert CalendarScreen navigation**
```typescript
(navigation as any).navigate('MeetingRoom', {
  meetingId: meeting.id,
  title: meeting.title,
  participants: meeting.participants,
  isOrganizer: meeting.organizerId === user.uid,
});
```

## Recommended Next Steps
1. **For now**: Keep using VideoCall for 1-on-1 meetings (current fix works)
2. **Later**: Create a proper MeetingRoom screen when you need multi-party support
3. **Multi-party features to implement**:
   - Grid layout for multiple video tiles
   - Speaker view (highlight active speaker)
   - Screen sharing
   - Meeting controls (mute all, end meeting)
   - Participant list
   - Chat during meeting

## Current Behavior
✅ Meetings will open in VideoCall screen
✅ Organizer can start the call
✅ Works for 1-on-1 or small meetings
⚠️ Only connects to first participant (not truly multi-party yet)
