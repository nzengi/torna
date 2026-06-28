/*
 * Torna v4 — pure B+ tree node layer.
 *
 * No Solana dependency: operates on raw node buffers, parameterized at runtime by
 * fanout F and value_size vs (exactly the on-account layout from design.md). This
 * file is compiled BOTH host-side (for the L1/L2 tests in test-plan.md) and into
 * the SBF program (which adds account validation + CPI around these ops).
 *
 * Layout of a node buffer:
 *   [0 .. NODE_HDR_SIZE)             NodeHeader
 *   [keys]   (F+1) slots * KEY_SIZE
 *   leaf:     [values]   (F+1) slots * vs
 *   internal: [children] (F+2) slots * u64
 *
 * The (F+1) / (F+2) slack holds the transient overflow between an insert and the
 * split that resolves it. A node holds <= F keys at rest, <= F+1 mid-insert.
 */
#ifndef TORNA_NODE_H
#define TORNA_NODE_H

/* On SBF, solana_sdk.h (included before us) already provides the integer types
 * and bool via sol/types.h; pulling <stdint.h> there redefines its macros. */
#ifndef TORNA_SBF
#include <stdint.h>
#include <stdbool.h>
#endif

/* Memory ops. SBF gives us sol_memcpy/sol_memset but NO memmove, so we supply a
 * correct overlap-aware one. Host build uses the standard library. The SBF .c
 * must define TORNA_SBF and include solana_sdk.h before this header. */
#ifdef TORNA_SBF
static inline void torna_memmove(void *dst, const void *src, uint64_t n) {
    uint8_t *d = (uint8_t *)dst;
    const uint8_t *s = (const uint8_t *)src;
    if (d < s)      { for (uint64_t i = 0; i < n; i++) d[i] = s[i]; }
    else if (d > s) { for (uint64_t i = n; i > 0; i--) d[i - 1] = s[i - 1]; }
}
#define TMEMCPY  sol_memcpy
#define TMEMMOVE torna_memmove
#else
#include <string.h>
#define TMEMCPY  memcpy
#define TMEMMOVE memmove
#endif

/* Debug assertions: active host-side (tests), compiled out on SBF. */
#if defined(TORNA_DEBUG) && !defined(TORNA_SBF)
#include <assert.h>
#define TORNA_ASSERT(x) assert(x)
#else
#define TORNA_ASSERT(x) ((void)0)
#endif

#define KEY_SIZE        32
#define VAL_SIZE_MAX    128
#define MAX_TREE_HEIGHT 32

/* Pure-op return codes (the SBF layer maps these to program error numbers). */
#define NODE_OK             0
#define NODE_DUPLICATE_KEY  1
#define NODE_KEY_NOT_FOUND  2

typedef struct __attribute__((packed)) {
    uint8_t  is_leaf;
    uint8_t  initialized;
    uint16_t key_count;
    uint16_t level;          /* 0 = leaf */
    uint16_t _pad;
    uint32_t tree_id;        /* cross-tree binding (threat T1.1) */
    uint64_t node_idx;       /* monotonic, never reused */
    uint64_t next_leaf_idx;  /* leaf chain forward, 0 if last/internal */
    uint8_t  tree_uid[16];   /* 128-bit tenant binding = sha256(creator||tree_id)[..16],
                              * set at node creation, checked on every use. tree_id alone
                              * is a client-chosen u32 that COLLIDES across creators;
                              * tree_uid makes (creator,tree_id) the real, unforgeable
                              * identity (a 128-bit second-preimage grind is infeasible).
                              * The chain is forward-only -- see invariants D1. */
} NodeHeader;

#define NODE_HDR_SIZE 44
_Static_assert(sizeof(NodeHeader) == NODE_HDR_SIZE, "NodeHeader must be 44 bytes packed");

/* ---- size helpers ---- */
static inline uint64_t node_keys_bytes(int F)  { return (uint64_t)(F + 1) * KEY_SIZE; }
static inline uint64_t node_vals_bytes(int F, int vs) { return (uint64_t)(F + 1) * vs; }
static inline uint64_t node_kids_bytes(int F)  { return (uint64_t)(F + 2) * 8; }

static inline uint64_t leaf_node_size(int F, int vs) {
    return NODE_HDR_SIZE + node_keys_bytes(F) + node_vals_bytes(F, vs);
}
static inline uint64_t internal_node_size(int F) {
    return NODE_HDR_SIZE + node_keys_bytes(F) + node_kids_bytes(F);
}

/* ---- accessors ---- */
static inline NodeHeader *node_hdr(uint8_t *d) { return (NodeHeader *)d; }
static inline uint8_t *node_keys(uint8_t *d)   { return d + NODE_HDR_SIZE; }
static inline uint8_t *node_vals(uint8_t *d, int F) {
    return d + NODE_HDR_SIZE + node_keys_bytes(F);
}
static inline uint64_t *node_kids(uint8_t *d, int F) {
    return (uint64_t *)(d + NODE_HDR_SIZE + node_keys_bytes(F));
}
static inline uint8_t *key_ptr(uint8_t *d, int i) {
    return node_keys(d) + (uint64_t)i * KEY_SIZE;
}
static inline uint8_t *val_ptr(uint8_t *d, int F, int vs, int i) {
    return node_vals(d, F) + (uint64_t)i * vs;
}

/* ---- key comparison (signed lexicographic; fixes the SDK memcmp trap) ---- */
static inline int key_cmp(const uint8_t *a, const uint8_t *b) {
    for (int i = 0; i < KEY_SIZE; i++) {
        if (a[i] != b[i]) return (int)a[i] - (int)b[i];
    }
    return 0;
}

/* First index i in [0, key_count] with keys[i] >= key. */
static inline int node_lower_bound(uint8_t *d, const uint8_t *key) {
    int lo = 0, hi = node_hdr(d)->key_count;
    while (lo < hi) {
        int mid = (lo + hi) >> 1;
        if (key_cmp(key_ptr(d, mid), key) < 0) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/* ===================== leaf operations ===================== */

/* Insert (key,value) at sorted position. Returns NODE_DUPLICATE_KEY on exact
 * match. May raise key_count to F+1 (caller splits if it now exceeds F). */
static inline int leaf_insert(uint8_t *d, const uint8_t *key, const uint8_t *value,
                              int F, int vs) {
    NodeHeader *h = node_hdr(d);
    TORNA_ASSERT(h->is_leaf);
    TORNA_ASSERT(h->key_count <= F);           /* at rest before insert */
    int pos = node_lower_bound(d, key);
    if (pos < h->key_count && key_cmp(key_ptr(d, pos), key) == 0)
        return NODE_DUPLICATE_KEY;

    int n = h->key_count - pos;                 /* entries to shift right */
    if (n > 0) {
        TMEMMOVE(key_ptr(d, pos + 1), key_ptr(d, pos), (uint64_t)n * KEY_SIZE);
        TMEMMOVE(val_ptr(d, F, vs, pos + 1), val_ptr(d, F, vs, pos), (uint64_t)n * vs);
    }
    TMEMCPY(key_ptr(d, pos), key, KEY_SIZE);
    TMEMCPY(val_ptr(d, F, vs, pos), value, vs);
    h->key_count++;
    TORNA_ASSERT(h->key_count <= F + 1);        /* transient overflow bound (F1) */
    return NODE_OK;
}

/* Delete key, copying the removed value to out_value if non-NULL. */
static inline int leaf_delete(uint8_t *d, const uint8_t *key, uint8_t *out_value,
                              int F, int vs) {
    NodeHeader *h = node_hdr(d);
    TORNA_ASSERT(h->is_leaf);
    int pos = node_lower_bound(d, key);
    if (pos >= h->key_count || key_cmp(key_ptr(d, pos), key) != 0)
        return NODE_KEY_NOT_FOUND;
    if (out_value) TMEMCPY(out_value, val_ptr(d, F, vs, pos), vs);

    int n = h->key_count - pos - 1;             /* entries to shift left */
    if (n > 0) {
        TMEMMOVE(key_ptr(d, pos), key_ptr(d, pos + 1), (uint64_t)n * KEY_SIZE);
        TMEMMOVE(val_ptr(d, F, vs, pos), val_ptr(d, F, vs, pos + 1), (uint64_t)n * vs);
    }
    h->key_count--;
    return NODE_OK;
}

/* Overwrite the value of an EXISTING key in place. No reorder, no key_count change,
 * so the leaf stays sorted and balanced (a pure hot-path value write). Returns
 * NODE_KEY_NOT_FOUND if the key is absent. */
static inline int leaf_update(uint8_t *d, const uint8_t *key, const uint8_t *value,
                              int F, int vs) {
    NodeHeader *h = node_hdr(d);
    TORNA_ASSERT(h->is_leaf);
    int pos = node_lower_bound(d, key);
    if (pos >= h->key_count || key_cmp(key_ptr(d, pos), key) != 0)
        return NODE_KEY_NOT_FOUND;
    TMEMCPY(val_ptr(d, F, vs, pos), value, vs);
    return NODE_OK;
}

/* Move the right half of an overfull leaf into `nd` (a fresh leaf). out_sep
 * receives the first key of the right leaf (the copy-up separator). Caller wires
 * the leaf chain and parent pointer. */
static inline void leaf_split(uint8_t *d, uint8_t *nd, uint8_t *out_sep, int F, int vs) {
    NodeHeader *lh = node_hdr(d);
    NodeHeader *rh = node_hdr(nd);
    int total = lh->key_count;
    int half  = total / 2;
    int moved = total - half;
    TORNA_ASSERT(moved > 0 && half > 0);

    TMEMCPY(key_ptr(nd, 0), key_ptr(d, half), (uint64_t)moved * KEY_SIZE);
    TMEMCPY(val_ptr(nd, F, vs, 0), val_ptr(d, F, vs, half), (uint64_t)moved * vs);
    rh->key_count = (uint16_t)moved;
    lh->key_count = (uint16_t)half;
    rh->is_leaf = 1;
    TMEMCPY(out_sep, key_ptr(nd, 0), KEY_SIZE);  /* B+ rule: separator = right[0] */
}

/* ===================== internal operations ===================== */

/* Insert separator `sep` with `right_child` to its right, at key index pos. */
static inline void internal_insert_at(uint8_t *d, int pos, const uint8_t *sep,
                                      uint64_t right_child, int F) {
    NodeHeader *h = node_hdr(d);
    TORNA_ASSERT(!h->is_leaf);
    uint64_t *kids = node_kids(d, F);
    int n = h->key_count - pos;
    if (n > 0)
        TMEMMOVE(key_ptr(d, pos + 1), key_ptr(d, pos), (uint64_t)n * KEY_SIZE);
    /* shift children right of the insert point (positions pos+1..count) up by 1 */
    for (int i = h->key_count + 1; i > pos + 1; i--) kids[i] = kids[i - 1];
    TMEMCPY(key_ptr(d, pos), sep, KEY_SIZE);
    kids[pos + 1] = right_child;
    h->key_count++;
    TORNA_ASSERT(h->key_count <= F + 1);
}

/* Split an overfull internal node. The middle key is PROMOTED via out_sep (not
 * kept in either child). Right half moves to `nd`. */
static inline void internal_split(uint8_t *d, uint8_t *nd, uint8_t *out_sep, int F) {
    NodeHeader *lh = node_hdr(d);
    NodeHeader *rh = node_hdr(nd);
    uint64_t *lk = node_kids(d, F);
    uint64_t *rk = node_kids(nd, F);
    int total = lh->key_count;
    int mid = total / 2;

    TMEMCPY(out_sep, key_ptr(d, mid), KEY_SIZE);
    int right_keys = total - mid - 1;
    TMEMCPY(key_ptr(nd, 0), key_ptr(d, mid + 1), (uint64_t)right_keys * KEY_SIZE);
    for (int i = 0; i <= right_keys; i++) rk[i] = lk[mid + 1 + i];
    rh->key_count = (uint16_t)right_keys;
    lh->key_count = (uint16_t)mid;
    rh->is_leaf = 0;
}

/* Remove separator at pos and child pointer at pos+1. */
static inline void internal_remove_at(uint8_t *d, int pos, int F) {
    NodeHeader *h = node_hdr(d);
    uint64_t *kids = node_kids(d, F);
    int n = h->key_count - pos - 1;
    if (n > 0)
        TMEMMOVE(key_ptr(d, pos), key_ptr(d, pos + 1), (uint64_t)n * KEY_SIZE);
    for (int i = pos + 1; i < h->key_count; i++) kids[i] = kids[i + 1];
    h->key_count--;
}

/* Remove the FIRST child (kids[0]) and its separator (keys[0]) from an internal node.
 * Used by CompactLeaf to drop an emptied leftmost leaf from its parent. (internal_
 * remove_at removes kids[pos+1], so it cannot drop kids[0].) */
static inline void internal_remove_first(uint8_t *d, int F) {
    NodeHeader *h = node_hdr(d);
    uint64_t *kids = node_kids(d, F);
    int kc = h->key_count;
    if (kc > 1) TMEMMOVE(key_ptr(d, 0), key_ptr(d, 1), (uint64_t)(kc - 1) * KEY_SIZE);
    for (int i = 0; i < kc; i++) kids[i] = kids[i + 1]; /* drop kids[0] */
    h->key_count--;
}

/* ===================== leaf borrow / merge ===================== */

/* Move right[0] into left's tail; parent separator at sep_pos becomes new right[0]. */
static inline void leaf_borrow_from_right(uint8_t *left, uint8_t *right, uint8_t *parent,
                                          int sep_pos, int F, int vs) {
    NodeHeader *lh = node_hdr(left);
    NodeHeader *rh = node_hdr(right);
    TMEMCPY(key_ptr(left, lh->key_count), key_ptr(right, 0), KEY_SIZE);
    TMEMCPY(val_ptr(left, F, vs, lh->key_count), val_ptr(right, F, vs, 0), vs);
    lh->key_count++;
    int n = rh->key_count - 1;
    TMEMMOVE(key_ptr(right, 0), key_ptr(right, 1), (uint64_t)n * KEY_SIZE);
    TMEMMOVE(val_ptr(right, F, vs, 0), val_ptr(right, F, vs, 1), (uint64_t)n * vs);
    rh->key_count--;
    TMEMCPY(key_ptr(parent, sep_pos), key_ptr(right, 0), KEY_SIZE);
}

/* Move left's last into right[0]; parent separator at sep_pos becomes new right[0]. */
static inline void leaf_borrow_from_left(uint8_t *left, uint8_t *right, uint8_t *parent,
                                         int sep_pos, int F, int vs) {
    NodeHeader *lh = node_hdr(left);
    NodeHeader *rh = node_hdr(right);
    int n = rh->key_count;
    TMEMMOVE(key_ptr(right, 1), key_ptr(right, 0), (uint64_t)n * KEY_SIZE);
    TMEMMOVE(val_ptr(right, F, vs, 1), val_ptr(right, F, vs, 0), (uint64_t)n * vs);
    TMEMCPY(key_ptr(right, 0), key_ptr(left, lh->key_count - 1), KEY_SIZE);
    TMEMCPY(val_ptr(right, F, vs, 0), val_ptr(left, F, vs, lh->key_count - 1), vs);
    rh->key_count++;
    lh->key_count--;
    TMEMCPY(key_ptr(parent, sep_pos), key_ptr(right, 0), KEY_SIZE);
}

/* Append right's entries to left and relink the chain (left.next = right.next).
 * Caller fixes the reverse pointer and frees `right`. */
static inline void leaf_merge(uint8_t *left, uint8_t *right, int F, int vs) {
    NodeHeader *lh = node_hdr(left);
    NodeHeader *rh = node_hdr(right);
    TORNA_ASSERT(lh->key_count + rh->key_count <= F);
    for (int i = 0; i < rh->key_count; i++) {
        TMEMCPY(key_ptr(left, lh->key_count + i), key_ptr(right, i), KEY_SIZE);
        TMEMCPY(val_ptr(left, F, vs, lh->key_count + i), val_ptr(right, F, vs, i), vs);
    }
    lh->key_count += rh->key_count;
    lh->next_leaf_idx = rh->next_leaf_idx;
}

/* ===================== internal borrow / merge ===================== */

/* cur underflowed; right sibling lends. cur gains parent.sep + sib.child[0];
 * parent.sep becomes sib.key[0]; sib shifts left by one. */
static inline void internal_borrow_from_right(uint8_t *cur, uint8_t *sib, uint8_t *parent,
                                              int sep_pos, int F) {
    NodeHeader *ch = node_hdr(cur);
    NodeHeader *sh = node_hdr(sib);
    uint64_t *ck = node_kids(cur, F);
    uint64_t *sk = node_kids(sib, F);
    TMEMCPY(key_ptr(cur, ch->key_count), key_ptr(parent, sep_pos), KEY_SIZE);
    ck[ch->key_count + 1] = sk[0];
    ch->key_count++;
    TMEMCPY(key_ptr(parent, sep_pos), key_ptr(sib, 0), KEY_SIZE);
    int n = sh->key_count - 1;
    TMEMMOVE(key_ptr(sib, 0), key_ptr(sib, 1), (uint64_t)n * KEY_SIZE);
    for (int i = 0; i < sh->key_count; i++) sk[i] = sk[i + 1];
    sh->key_count--;
}

/* cur underflowed; left sibling lends. cur shifts right by one; cur gains
 * parent.sep as key[0] and sib's last child as child[0]; parent.sep becomes
 * sib's last key. */
static inline void internal_borrow_from_left(uint8_t *sib, uint8_t *cur, uint8_t *parent,
                                             int sep_pos, int F) {
    NodeHeader *sh = node_hdr(sib);
    NodeHeader *ch = node_hdr(cur);
    uint64_t *sk = node_kids(sib, F);
    uint64_t *ck = node_kids(cur, F);
    TMEMMOVE(key_ptr(cur, 1), key_ptr(cur, 0), (uint64_t)ch->key_count * KEY_SIZE);
    for (int i = ch->key_count + 1; i > 0; i--) ck[i] = ck[i - 1];
    TMEMCPY(key_ptr(cur, 0), key_ptr(parent, sep_pos), KEY_SIZE);
    ck[0] = sk[sh->key_count];
    ch->key_count++;
    TMEMCPY(key_ptr(parent, sep_pos), key_ptr(sib, sh->key_count - 1), KEY_SIZE);
    sh->key_count--;
}

/* Pull parent.sep + all of `right` into `left`. Caller removes parent.sep via
 * internal_remove_at(sep_pos) and frees `right`. */
static inline void internal_merge_right(uint8_t *left, uint8_t *right, uint8_t *parent,
                                        int sep_pos, int F) {
    NodeHeader *lh = node_hdr(left);
    NodeHeader *rh = node_hdr(right);
    uint64_t *lk = node_kids(left, F);
    uint64_t *rk = node_kids(right, F);
    TORNA_ASSERT(lh->key_count + 1 + rh->key_count <= F);
    TMEMCPY(key_ptr(left, lh->key_count), key_ptr(parent, sep_pos), KEY_SIZE);
    for (int i = 0; i < rh->key_count; i++)
        TMEMCPY(key_ptr(left, lh->key_count + 1 + i), key_ptr(right, i), KEY_SIZE);
    for (int i = 0; i <= rh->key_count; i++)
        lk[lh->key_count + 1 + i] = rk[i];
    lh->key_count = lh->key_count + 1 + rh->key_count;
}

#endif /* TORNA_NODE_H */
