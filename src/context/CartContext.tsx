// ─── CartContext ───────────────────────────────────────────────────────────────
//
// STATE MANAGEMENT CHOICE: React Context + useReducer
//
// Why NOT Zustand / Redux / MobX:
//   • The project has zero external state-management libs — adding one just for
//     a cart would introduce an unnecessary dependency and a different pattern
//     from the rest of the codebase.
//
// Why NOT useState in a component:
//   • The cart must be accessible from both ProfileScreen (where items are shared)
//     and ChatScreen (where the cart badge + sheet live). Lifting that state up
//     to App.tsx with plain useState would mean prop-drilling through the entire
//     navigator tree.
//
// Why Context + useReducer specifically:
//   • Context makes the cart available to any screen/component without prop-drilling.
//   • useReducer keeps all mutation logic in one pure `cartReducer` function,
//     making every state change explicit, traceable, and easy to test.
//   • The cart state is ephemeral (session-only, no persistence needed) so
//     AsyncStorage / Firestore sync would be over-engineering.
//   • This is the exact pattern React docs recommend for "shared, complex local state".
//
// Shape:
//   items: CartItem[]          — items currently in the cart (keyed by item.id + sellerUid)
//   sellerUid: string | null   — all items in one cart must belong to the same seller
//
// Actions:
//   ADD_ITEM      — add 1 of an item (creates entry or increments quantity)
//   REMOVE_ITEM   — remove 1 of an item (decrements or drops entry)
//   SET_QUANTITY  — set exact quantity (0 = remove)
//   CLEAR_CART    — empty the cart (after sending order or changing seller)
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  createContext, useContext, useReducer, useCallback, useMemo,
} from 'react';
import { CartItem, CatalogItem } from '../types';

// ── State shape ───────────────────────────────────────────────────────────────
interface CartState {
  items:     CartItem[];
  sellerUid: string | null; // all items must belong to the same seller
}

const initialState: CartState = {
  items:     [],
  sellerUid: null,
};

// ── Action union ──────────────────────────────────────────────────────────────
type CartAction =
  | { type: 'ADD_ITEM';     item: CatalogItem; sellerUid: string }
  | { type: 'REMOVE_ITEM';  itemId: string }
  | { type: 'SET_QUANTITY'; itemId: string; quantity: number }
  | { type: 'CLEAR_CART' };

// ── Pure reducer ──────────────────────────────────────────────────────────────
function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {

    case 'ADD_ITEM': {
      // If cart already has items from a different seller, clear first
      if (state.sellerUid && state.sellerUid !== action.sellerUid) {
        return {
          sellerUid: action.sellerUid,
          items: [{ item: action.item, quantity: 1, sellerUid: action.sellerUid }],
        };
      }

      const existing = state.items.findIndex(c => c.item.id === action.item.id);
      if (existing !== -1) {
        // Increment quantity
        const updated = [...state.items];
        updated[existing] = { ...updated[existing], quantity: updated[existing].quantity + 1 };
        return { ...state, items: updated };
      }

      // New item
      return {
        sellerUid: action.sellerUid,
        items: [...state.items, { item: action.item, quantity: 1, sellerUid: action.sellerUid }],
      };
    }

    case 'REMOVE_ITEM': {
      const existing = state.items.findIndex(c => c.item.id === action.itemId);
      if (existing === -1) return state;

      const current = state.items[existing];
      if (current.quantity > 1) {
        const updated = [...state.items];
        updated[existing] = { ...current, quantity: current.quantity - 1 };
        return { ...state, items: updated };
      }

      // Drop the entry entirely
      const remaining = state.items.filter(c => c.item.id !== action.itemId);
      return {
        items:     remaining,
        sellerUid: remaining.length > 0 ? state.sellerUid : null,
      };
    }

    case 'SET_QUANTITY': {
      if (action.quantity <= 0) {
        const remaining = state.items.filter(c => c.item.id !== action.itemId);
        return {
          items:     remaining,
          sellerUid: remaining.length > 0 ? state.sellerUid : null,
        };
      }

      const updated = state.items.map(c =>
        c.item.id === action.itemId ? { ...c, quantity: action.quantity } : c,
      );
      return { ...state, items: updated };
    }

    case 'CLEAR_CART':
      return initialState;

    default:
      return state;
  }
}

// ── Context value ─────────────────────────────────────────────────────────────
interface CartContextValue {
  // State
  items:      CartItem[];
  sellerUid:  string | null;
  totalItems: number;         // sum of all quantities — used for badge
  totalPrice: number | null;  // numeric total if all prices are parseable, else null

  // Actions
  addItem:     (item: CatalogItem, sellerUid: string) => void;
  removeItem:  (itemId: string) => void;
  setQuantity: (itemId: string, quantity: number) => void;
  clearCart:   () => void;
  getQuantity: (itemId: string) => number;

  // Serialise the cart into a readable order-summary string for sending as a message
  formatOrderSummary: () => string;
}

const CartContext = createContext<CartContextValue | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────────
export function CartProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(cartReducer, initialState);

  const addItem = useCallback((item: CatalogItem, sellerUid: string) => {
    dispatch({ type: 'ADD_ITEM', item, sellerUid });
  }, []);

  const removeItem = useCallback((itemId: string) => {
    dispatch({ type: 'REMOVE_ITEM', itemId });
  }, []);

  const setQuantity = useCallback((itemId: string, quantity: number) => {
    dispatch({ type: 'SET_QUANTITY', itemId, quantity });
  }, []);

  const clearCart = useCallback(() => {
    dispatch({ type: 'CLEAR_CART' });
  }, []);

  const getQuantity = useCallback((itemId: string): number => {
    return state.items.find(c => c.item.id === itemId)?.quantity ?? 0;
  }, [state.items]);

  const totalItems = useMemo(
    () => state.items.reduce((sum, c) => sum + c.quantity, 0),
    [state.items],
  );

  // Try to parse each price string as a number; if any fails, return null
  const totalPrice = useMemo((): number | null => {
    let total = 0;
    for (const c of state.items) {
      const raw = c.item.price.replace(/[^0-9.]/g, '');
      const n   = parseFloat(raw);
      if (isNaN(n)) return null;
      total += n * c.quantity;
    }
    return total;
  }, [state.items]);

  // Build a human-readable order summary to paste into a chat message
  const formatOrderSummary = useCallback((): string => {
    if (state.items.length === 0) return '';
    const lines = state.items.map(c => {
      const subtotal = (() => {
        const raw = c.item.price.replace(/[^0-9.]/g, '');
        const n   = parseFloat(raw);
        if (isNaN(n)) return c.item.price;
        // Preserve currency prefix (e.g. "R", "$")
        const prefix = c.item.price.match(/^[^0-9]*/)?.[0] ?? '';
        return `${prefix}${(n * c.quantity).toFixed(2)}`;
      })();
      return `• ${c.item.name} x${c.quantity} — ${subtotal}`;
    });
    const totalLine = totalPrice !== null
      ? `\nTotal: ${state.items[0]?.item.price.match(/^[^0-9]*/)?.[0] ?? ''}${totalPrice.toFixed(2)}`
      : '';
    return `🛒 Order Summary\n${lines.join('\n')}${totalLine}`;
  }, [state.items, totalPrice]);

  const value = useMemo<CartContextValue>(() => ({
    items:      state.items,
    sellerUid:  state.sellerUid,
    totalItems,
    totalPrice,
    addItem,
    removeItem,
    setQuantity,
    clearCart,
    getQuantity,
    formatOrderSummary,
  }), [state, totalItems, totalPrice, addItem, removeItem, setQuantity, clearCart, getQuantity, formatOrderSummary]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used inside <CartProvider>');
  return ctx;
}
