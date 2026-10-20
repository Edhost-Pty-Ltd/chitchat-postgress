// Privacy settings domain types. Values mirror the app's PrivacySettings
// (usePrivacySettings.ts): visibility is 'Everyone' | 'Contacts' | 'Nobody'.

export type Visibility = 'Everyone' | 'Contacts' | 'Nobody';

export const VISIBILITY_VALUES: Visibility[] = ['Everyone', 'Contacts', 'Nobody'];

export interface PrivacySettings {
  lastSeen: Visibility;
  profilePhoto: Visibility;
  statusVisibility: Visibility;
  groups: Visibility;
  calls: Visibility;
  readReceipts: boolean;
  disappearingMessages: boolean;
}

export const DEFAULT_PRIVACY: PrivacySettings = {
  lastSeen: 'Contacts',
  profilePhoto: 'Contacts',
  statusVisibility: 'Everyone',
  groups: 'Contacts',
  calls: 'Contacts',
  readReceipts: true,
  disappearingMessages: true,
};

/**
 * Whether a value gated by `setting` is visible to a viewer, given whether the
 * viewer is a contact. 'Everyone' always; 'Nobody' never; 'Contacts' only when
 * the viewer is a contact (Req 4.4, 7.5). Pure — unit tested.
 */
export function isVisibleTo(setting: Visibility, viewerIsContact: boolean): boolean {
  if (setting === 'Everyone') return true;
  if (setting === 'Nobody') return false;
  return viewerIsContact;
}
