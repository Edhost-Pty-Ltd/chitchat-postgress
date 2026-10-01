# Multi-Agent Team Inbox — Data Model & Architecture

## Overview

The team inbox feature adds **agent identity**, **conversation assignment**, and **auditable history** on top of the existing Firestore data model without breaking any existing functionality.

---

## New Firestore Collections

### `businessTeams/{ownerUid}/agents/{agentUid}`

Stores all agents that belong to a business owner's team.

```
{
  uid:         string          // = agentUid (doc id)
  displayName: string
  photoURL:    string | null
  phone:       string          // E.164, e.g. "+27821234567"
  role:        "admin" | "agent"
  addedAt:     Timestamp
  addedBy:     string          // UID of admin who added them
  isActive:    boolean
}
```

- `ownerUid` = the business owner's Firebase Auth UID
- Each agent entry is looked up by the agent's own UID

**Access rules:**
- Owner can read/write/delete any agent entry
- Agent can read their own entry
- Agent cannot change their own role

---

### `users/{agentUid}` — back-reference fields (added on agent add, removed on remove)

```
{
  businessOwnerUid: string | undefined   // points to the ownerUid above
  agentRole:        "admin" | "agent" | undefined
}
```

These fields let any screen quickly resolve "which business does this user belong to?" with a single document read (no cross-collection query required).

---

### `chats/{chatId}` — assignment fields (added to existing chat documents)

```
{
  // ...existing fields unchanged...

  // Team inbox fields (absent on non-business chats, treated as defaults)
  status:          "open" | "assigned" | "resolved"   // default: absent → treated as "open"
  assignedTo:      string | null                       // UID of assigned agent
  assignedToName:  string | null                       // denormalized name for display
  assignedAt:      Timestamp | null
  resolvedAt:      Timestamp | null
  resolvedBy:      string | null                       // UID
}
```

- Existing chats without these fields behave as `status: "open"`, `assignedTo: null`
- No migration needed — fields are written on first assignment action

---

### `chats/{chatId}/assignmentHistory/{entryId}`

Immutable audit log of every ownership change on a conversation.

```
{
  action:    "assigned" | "transferred" | "resolved" | "reopened" | "taken"
  byUid:     string       // who performed the action
  byName:    string       // denormalized name
  toUid:     string | null  // null for resolved/reopened
  toName:    string | null
  timestamp: Timestamp
  note?:     string       // optional free-text note (future)
}
```

- Entries are created atomically in a batch write with the chat document update
- Entries are **never updated or deleted** (append-only audit trail)

---

## Role Model

| User type | `businessOwnerUid` | `agentRole` | Capabilities |
|-----------|-------------------|-------------|--------------|
| Business owner | absent | absent | Full access; can add/remove/promote agents; sees all conversations |
| Admin agent | `= ownerUid` | `"admin"` | Same inbox access as owner; can assign/transfer/resolve; can promote/demote agents |
| Regular agent | `= ownerUid` | `"agent"` | Sees own + unassigned open conversations; can take/resolve own conversations |

**`TeamInboxContext` resolves role on mount** by reading `users/{uid}.businessOwnerUid`:
- If absent → user is the owner (`role = "owner"`, `ownerUid = uid`)
- If present → user is an agent; fetch their role from the `agents` sub-collection

---

## Real-time Behaviour

All assignment state is stored directly on `chats/{chatId}` — the existing `onSnapshot` listeners in `useChats` and `useConversationAssignment` pick up changes immediately on all connected devices without any polling or app refresh.

**`useInboxConversations`** subscribes to `chats where members array-contains ownerUid`:
- Non-admins receive the full snapshot but filter client-side to avoid complex Firestore indexes
- Sort: unresolved first, then by most recent message timestamp

**`useConversationAssignment`** subscribes to a single `chats/{chatId}` document for live assignment state displayed in the ChatScreen banner.

---

## Firestore Indexes Required

The following composite indexes are needed (add in Firebase Console or `firestore.indexes.json`):

```json
{
  "indexes": [
    {
      "collectionGroup": "chats",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "members",   "arrayConfig": "CONTAINS" },
        { "fieldPath": "assignedTo","order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "agents",
      "queryScope": "COLLECTION_GROUP",
      "fields": [
        { "fieldPath": "addedAt", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "assignmentHistory",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "timestamp", "order": "DESCENDING" }
      ]
    }
  ]
}
```

The `members + assignedTo` index is only needed if you want server-side filtering for non-admins in future. The current implementation filters client-side, so only the existing `members array-contains` index (auto-created by Firestore) is strictly required to start.

---

## Linked Devices vs Human Agents

These are **separate concepts** and are kept separate deliberately:

- **Linked devices** (`LinkedDevicesScreen`) — secondary devices for the *same* business account (same Firebase UID). Currently mock-only with no Firestore backing.
- **Human agents** (`businessTeams/{ownerUid}/agents/{agentUid}`) — separate Firebase Auth accounts operated by different people, with their own identity, presence, and permissions.

There is no overlap in data model or auth flow between the two.

---

## Migration & Safety

- **Zero-downtime** — all new fields are optional/additive on existing documents
- **Existing chats** without assignment fields work as before; the app treats missing `status` as `"open"`
- **Existing users** without `businessOwnerUid` are treated as standalone business owners
- **No breaking changes** to `useChats`, `useMessages`, or any existing hook
