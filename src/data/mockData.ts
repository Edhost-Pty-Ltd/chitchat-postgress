// ─── Mock Data ────────────────────────────────────────────────────────────────
import { Contact, Message, Call, StatusUpdate } from '../types';

export const CONTACTS: Contact[] = [
  { id: 1, name: 'Anna Martin',   avatar: 'AM', color: '#f97316', status: 'online',  lastMsg: 'Hey! How are you?',           time: '9:40 AM',   unread: 2 },
  { id: 2, name: 'Kevin Patel',   avatar: 'KP', color: '#8b5cf6', status: 'online',  lastMsg: "Let's catch up later.",        time: '9:22 AM',   unread: 1 },
  { id: 3, name: 'Sophie Lee',    avatar: 'SL', color: '#ec4899', status: 'away',    lastMsg: 'Thanks! 🎉',                   time: 'Yesterday', unread: 0 },
  {
    id: 4, name: 'Team Office', avatar: 'TO', color: '#06b6d4', status: 'online',
    lastMsg: 'John: Meeting at 3 PM', time: 'Yesterday', unread: 0, pinned: true,
    members: [
      { id: 1, name: 'Anna Martin',  avatar: 'AM', color: '#f97316', status: 'online',  lastMsg: '', time: '', unread: 0 },
      { id: 2, name: 'Kevin Patel',  avatar: 'KP', color: '#8b5cf6', status: 'online',  lastMsg: '', time: '', unread: 0 },
      { id: 3, name: 'Sophie Lee',   avatar: 'SL', color: '#ec4899', status: 'away',    lastMsg: '', time: '', unread: 0 },
      { id: 5, name: 'Liam Johnson', avatar: 'LJ', color: '#10b981', status: 'offline', lastMsg: '', time: '', unread: 0 },
    ],
  },
  { id: 5, name: 'Liam Johnson',  avatar: 'LJ', color: '#10b981', status: 'offline', lastMsg: 'See you soon!',                time: 'Monday',    unread: 0 },
  {
    id: 6, name: 'Family Group', avatar: 'FG', color: '#f59e0b', status: 'online',
    lastMsg: 'Mom: Dinner at 7?', time: 'Sunday', unread: 0,
    members: [
      { id: 10, name: 'Mom',      avatar: 'MO', color: '#e11d48', status: 'online',  lastMsg: '', time: '', unread: 0 },
      { id: 11, name: 'Dad',      avatar: 'DA', color: '#0ea5e9', status: 'offline', lastMsg: '', time: '', unread: 0 },
      { id: 12, name: 'Grandma',  avatar: 'GR', color: '#f59e0b', status: 'away',    lastMsg: '', time: '', unread: 0 },
      { id: 13, name: 'Sister',   avatar: 'SI', color: '#ec4899', status: 'online',  lastMsg: '', time: '', unread: 0 },
    ],
  },
  {
    id: 7, name: 'Design Team', avatar: 'DT', color: '#6366f1', status: 'away',
    lastMsg: 'Emily: New mockups ready!', time: 'Sunday', unread: 0,
    members: [
      { id: 20, name: 'Emily Chen',   avatar: 'EC', color: '#6366f1', status: 'away',   lastMsg: '', time: '', unread: 0 },
      { id: 21, name: 'Marcus Webb',  avatar: 'MW', color: '#8b5cf6', status: 'online', lastMsg: '', time: '', unread: 0 },
      { id: 22, name: 'Priya Nair',   avatar: 'PN', color: '#ec4899', status: 'online', lastMsg: '', time: '', unread: 0 },
    ],
  },
];

export const MESSAGES: Message[] = [
  { id: 1, from: 'Anna', text: 'Hey! How are you?',       time: '9:40 AM', type: 'in'  },
  { id: 2, from: 'me',   text: "I'm good! How about you?", time: '9:41 AM', type: 'out' },
  { id: 3, from: 'Anna', text: "I'm great! 😊",            time: '9:41 AM', type: 'in'  },
  { id: 4, from: 'Anna', image: true,                      time: '9:42 AM', type: 'in'  },
  { id: 5, from: 'Anna', voice: true,                      time: '9:42 AM', type: 'in'  },
  { id: 6, from: 'me',   text: 'Wow! This is beautiful 😍', time: '9:43 AM', type: 'out' },
];

export const CALLS: Call[] = [
  { id: 1, name: 'Anna Martin',  avatar: 'AM', color: '#f97316', type: 'Outgoing', time: '9:40 AM',   missed: false },
  { id: 2, name: 'Kevin Patel',  avatar: 'KP', color: '#8b5cf6', type: 'Incoming', time: '9:32 AM',   missed: false },
  { id: 3, name: 'Sophie Lee',   avatar: 'SL', color: '#ec4899', type: 'Missed',   time: 'Yesterday', missed: true  },
  { id: 4, name: 'Liam Johnson', avatar: 'LJ', color: '#10b981', type: 'Outgoing', time: 'Monday',    missed: false },
  { id: 5, name: 'Team Office',  avatar: 'TO', color: '#06b6d4', type: 'Incoming', time: 'Monday',    missed: false },
  { id: 6, name: 'Grandma',      avatar: 'GR', color: '#f59e0b', type: 'Outgoing', time: 'Sunday',    missed: false },
  { id: 7, name: 'Best Friends', avatar: 'BF', color: '#6366f1', type: 'Outgoing', time: 'Sunday',    missed: false },
  { id: 8, name: 'Mom',          avatar: 'MO', color: '#e11d48', type: 'Missed',   time: 'Sunday',    missed: true  },
];

export const STATUSES: StatusUpdate[] = [
  { id: 1, name: 'Anna Martin',  avatar: 'AM', color: '#f97316', time: 'Just now' },
  { id: 2, name: 'Kevin Patel',  avatar: 'KP', color: '#8b5cf6', time: '5m ago'   },
  { id: 3, name: 'Sophie Lee',   avatar: 'SL', color: '#ec4899', time: '25m ago'  },
  { id: 4, name: 'Liam Johnson', avatar: 'LJ', color: '#10b981', time: '1h ago'   },
  { id: 5, name: 'Team Office',  avatar: 'TO', color: '#06b6d4', time: '2h ago'   },
];

