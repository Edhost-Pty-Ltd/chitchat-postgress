import React from 'react';
import { View, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { AppIcon, AppText } from '../context/ThemeContext';
import { COLORS, GRADIENTS, RADIUS } from '../types/theme';

interface Props {
  /** Must come from the backend's `identityVerified`, never local UI state. */
  verified: boolean;
  compact?: boolean;
  showLabel?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * One consistent identity-status treatment for owner and public profiles.
 * It deliberately says "Identity verified", not "safe" or "trusted": facial
 * continuity proves identity, not that the user's future behaviour is safe.
 */
export default function IdentityVerificationBadge({
  verified,
  compact = false,
  showLabel = true,
  style,
}: Props) {
  const content = (
    <>
      <AppIcon
        name={verified ? 'shield-checkmark' : 'shield-outline'}
        size={compact ? 12 : 15}
        color={verified ? '#fff' : '#B45309'}
        fixedColor
      />
      {showLabel ? (
        <AppText
          fixedColor
          style={[
            styles.label,
            compact && styles.labelCompact,
            { color: verified ? '#fff' : '#92400E' },
          ]}
        >
          {verified ? 'Identity verified' : 'Not verified'}
        </AppText>
      ) : null}
    </>
  );

  if (verified) {
    return (
      <LinearGradient
        colors={GRADIENTS.primary}
        style={[styles.badge, compact && styles.compact, style]}
        accessible
        accessibilityRole="text"
        accessibilityLabel="Identity verified"
      >
        {content}
      </LinearGradient>
    );
  }

  return (
    <View
      style={[styles.badge, styles.unverified, compact && styles.compact, style]}
      accessible
      accessibilityRole="text"
      accessibilityLabel="Identity not verified"
    >
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: RADIUS.full,
  },
  compact: { paddingHorizontal: 6, paddingVertical: 3, gap: 3 },
  unverified: {
    backgroundColor: '#FEF3C7',
    borderWidth: 1,
    borderColor: '#F59E0B',
  },
  label: { fontSize: 11.5, fontWeight: '800' },
  labelCompact: { fontSize: 10 },
});
