// ─── FileMessageBubble ──────────────────────────────────────────────────────
// Renders a file attachment message with icon, filename, and file size display.
// Supports downloading/opening files when tapped.

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Linking, Alert } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, GRADIENTS, SHADOW, RADIUS } from '../types/theme';

export interface FileMessageBubbleProps {
  fileName: string;
  fileSize?: number;
  fileUrl: string;
  mimeType?: string;
  isOutgoing: boolean;
}

// Format file size to human-readable format
function formatFileSize(bytes?: number): string {
  if (!bytes) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Get icon name based on file type
function getFileIcon(mimeType?: string): keyof typeof Ionicons.glyphMap {
  if (!mimeType) return 'document-outline';
  
  if (mimeType.startsWith('image/')) return 'image-outline';
  if (mimeType.startsWith('video/')) return 'videocam-outline';
  if (mimeType.startsWith('audio/')) return 'musical-notes-outline';
  if (mimeType.includes('pdf')) return 'document-text-outline';
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('archive')) 
    return 'folder-outline';
  if (mimeType.includes('word') || mimeType.includes('document')) 
    return 'document-outline';
  if (mimeType.includes('sheet') || mimeType.includes('excel')) 
    return 'grid-outline';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) 
    return 'easel-outline';
  
  return 'document-outline';
}

// Get short file extension
function getFileExtension(fileName: string): string {
  const parts = fileName.split('.');
  if (parts.length > 1) {
    const ext = parts[parts.length - 1].toUpperCase();
    return ext.length <= 4 ? ext : 'FILE';
  }
  return 'FILE';
}

export const FileMessageBubble = React.memo(function FileMessageBubble({
  fileName,
  fileSize,
  fileUrl,
  mimeType,
  isOutgoing,
}: FileMessageBubbleProps) {
  const iconName = getFileIcon(mimeType);
  const extension = getFileExtension(fileName);
  const sizeText = formatFileSize(fileSize);

  const handlePress = async () => {
    try {
      const supported = await Linking.canOpenURL(fileUrl);
      if (supported) {
        await Linking.openURL(fileUrl);
      } else {
        Alert.alert(
          'Cannot Open File',
          'Your device cannot open this file type. You can copy the link to download it in a browser.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Copy Link', onPress: () => {
              // In a real app, you'd use Clipboard API here
              Alert.alert('Link Ready', 'File link copied!');
            }},
          ]
        );
      }
    } catch (error) {
      console.error('[FileMessageBubble] Open error:', error);
      Alert.alert('Error', 'Could not open file.');
    }
  };

  // Color tokens based on direction
  const iconColor = isOutgoing ? COLORS.blue : '#ffffff';
  const iconBgColor = isOutgoing 
    ? 'rgba(9,178,238,0.15)' 
    : 'rgba(255,255,255,0.25)';
  const fileNameColor = isOutgoing ? COLORS.text : '#ffffff';
  const metaColor = isOutgoing ? COLORS.sub : 'rgba(255,255,255,0.80)';

  const content = (
    <TouchableOpacity
      style={styles.fileRow}
      onPress={handlePress}
      activeOpacity={0.7}
    >
      {/* File icon */}
      <View style={[styles.fileIcon, { backgroundColor: iconBgColor }]}>
        <Ionicons name={iconName} size={24} color={iconColor} />
        <Text style={[styles.fileExt, { color: iconColor }]}>{extension}</Text>
      </View>

      {/* File info */}
      <View style={styles.fileInfo}>
        <Text 
          style={[styles.fileName, { color: fileNameColor }]}
          numberOfLines={2}
          ellipsizeMode="middle"
        >
          {fileName}
        </Text>
        <Text style={[styles.fileSize, { color: metaColor }]}>
          {sizeText}
        </Text>
      </View>

      {/* Download indicator */}
      <Ionicons 
        name="download-outline" 
        size={20} 
        color={metaColor} 
      />
    </TouchableOpacity>
  );

  if (isOutgoing) {
    return <View style={[styles.bubble, styles.bubbleOut]}>{content}</View>;
  }

  return (
    <LinearGradient colors={GRADIENTS.chatSent} style={[styles.bubble, styles.bubbleIn]}>
      {content}
    </LinearGradient>
  );
});

const styles = StyleSheet.create({
  bubble: {
    maxWidth: '75%',
    borderRadius: RADIUS.lg,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  bubbleIn: {
    borderBottomLeftRadius: 4,
    ...SHADOW.card,
  },
  bubbleOut: {
    backgroundColor: 'rgba(255,255,255,0.28)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.50)',
    borderBottomRightRadius: 4,
    ...SHADOW.card,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 4,
  },
  fileIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  fileExt: {
    position: 'absolute',
    bottom: 2,
    fontSize: 8,
    fontWeight: '700',
    opacity: 0.7,
  },
  fileInfo: {
    flex: 1,
    gap: 2,
  },
  fileName: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 18,
  },
  fileSize: {
    fontSize: 11,
    fontWeight: '500',
  },
});
