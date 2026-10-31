// ─── LocationSearchModal ──────────────────────────────────────────────────────
// Real place search for the in-person meeting venue. Queries the backend
// /places proxy (Google Places when a key is configured, else OpenStreetMap
// Nominatim — both return real, existing places), debounced as the user types.
// On selection it resolves coordinates (via /places/details for Google
// suggestions that don't carry them) and returns the chosen place.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, FlatList,
  ActivityIndicator, Modal, Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, RADIUS, SHADOW } from '../types/theme';
import { endpoints, type PlaceResult } from '../api/endpoints';

export interface SelectedPlace {
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  placeId: string;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect: (place: SelectedPlace) => void;
}

function newSessionToken(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function LocationSearchModal({ visible, onClose, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const sessionToken = useRef(newSessionToken());
  const reqSeq = useRef(0);

  useEffect(() => {
    if (!visible) {
      setQuery('');
      setResults([]);
      setLoading(false);
      setResolving(false);
      sessionToken.current = newSessionToken();
    }
  }, [visible]);

  // Debounced autocomplete.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const seq = ++reqSeq.current;
    const handle = setTimeout(async () => {
      const res = await endpoints.placesAutocomplete(q, sessionToken.current);
      if (seq !== reqSeq.current) return; // a newer keystroke superseded this
      setResults(res.ok ? res.data.results : []);
      setLoading(false);
    }, 320);
    return () => clearTimeout(handle);
  }, [query]);

  const handlePick = useCallback(
    async (place: PlaceResult) => {
      // Nominatim already carries coordinates; Google suggestions need details.
      let lat = place.lat;
      let lng = place.lng;
      let address = place.address;
      let name = place.name;
      if ((lat == null || lng == null) && !place.placeId.startsWith('osm:')) {
        setResolving(true);
        const res = await endpoints.placeDetails(place.placeId, sessionToken.current);
        setResolving(false);
        if (res.ok && res.data.place) {
          lat = res.data.place.lat;
          lng = res.data.place.lng;
          address = res.data.place.address || address;
          name = res.data.place.name || name;
        }
      }
      onSelect({ name, address, lat, lng, placeId: place.placeId });
      // Fresh token for the next independent search session.
      sessionToken.current = newSessionToken();
    },
    [onSelect],
  );

  const emptyLabel = useMemo(() => {
    if (loading) return null;
    if (query.trim().length < 2) return 'Type to search for a place';
    return `No places found for "${query.trim()}"`;
  }, [loading, query]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.headerRow}>
          <Text style={styles.headerTitle}>Choose a venue</Text>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close" size={22} color={COLORS.sub} />
          </TouchableOpacity>
        </View>

        <View style={styles.searchRow}>
          <Ionicons name="search-outline" size={18} color={COLORS.sub} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search address or place…"
            placeholderTextColor={COLORS.sub}
            value={query}
            onChangeText={setQuery}
            autoFocus
            autoCorrect={false}
            returnKeyType="search"
          />
          {(loading || resolving) && <ActivityIndicator size="small" color={COLORS.blue} />}
          {query.length > 0 && !loading && !resolving && (
            <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={18} color={COLORS.sub} />
            </TouchableOpacity>
          )}
        </View>

        <FlatList
          data={results}
          keyExtractor={(item) => item.placeId}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 24 }}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.resultRow} activeOpacity={0.7} onPress={() => handlePick(item)}>
              <View style={styles.resultIconWrap}>
                <Ionicons name="location-outline" size={18} color={COLORS.blue} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.resultName} numberOfLines={1}>{item.name}</Text>
                {!!item.address && <Text style={styles.resultAddr} numberOfLines={2}>{item.address}</Text>}
              </View>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            emptyLabel ? (
              <View style={styles.emptyWrap}>
                <Ionicons name="map-outline" size={40} color={COLORS.sub} />
                <Text style={styles.emptyText}>{emptyLabel}</Text>
              </View>
            ) : null
          }
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '82%',
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: 'hidden',
    ...SHADOW.glow,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(0,0,0,0.15)',
    marginTop: 10,
    marginBottom: 6,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingBottom: 10,
  },
  headerTitle: { fontSize: 17, fontWeight: '800', color: COLORS.text },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.18)',
    backgroundColor: 'rgba(30,156,240,0.06)',
  },
  searchInput: { flex: 1, fontSize: 15, color: COLORS.text, paddingVertical: 0 },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.05)',
  },
  resultIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(30,156,240,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  resultName: { fontSize: 14.5, fontWeight: '700', color: COLORS.text },
  resultAddr: { fontSize: 12.5, color: COLORS.sub, marginTop: 1 },
  emptyWrap: { alignItems: 'center', paddingTop: 60, gap: 10 },
  emptyText: { fontSize: 13.5, color: COLORS.sub, textAlign: 'center', paddingHorizontal: 40 },
});
