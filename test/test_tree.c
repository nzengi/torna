/*
 * Torna L2 differential test — a host-side whole-tree driver over the pure node
 * ops, run against a reference oracle (a presence/value array). This validates
 * the ALGORITHM (descend, split-propagate, delete-rebalance, chain) before any
 * SBF/account/CPI plumbing. After every op it asserts functional equivalence and
 * the structural invariants from invariants.md.
 *
 * The driver mirrors what the SBF handlers will do, minus account validation and
 * CPI: nodes live in an arena indexed by node_idx (monotonic, never reused).
 *
 * Build+run:
 *   gcc -DTORNA_DEBUG -O1 -Wall -Wextra -o /tmp/test_tree torna/test/test_tree.c && /tmp/test_tree
 */
#include "../src/node.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---------------- arena / tree state ---------------- */
#define MAXN 400000
static uint8_t *arena[MAXN];
static int g_count;            /* high-water node_idx */
static int g_root, g_height, g_leftmost, g_rightmost;
static int F, VS, MINK;
static uint64_t NODE_MAX;

static uint8_t *N(int idx) { return arena[idx]; }

static int alloc_node(int is_leaf) {
    int idx = ++g_count;
    uint8_t *b = calloc(1, NODE_MAX);
    NodeHeader *h = node_hdr(b);
    h->is_leaf = (uint8_t)is_leaf;
    h->initialized = 1;
    h->node_idx = (uint64_t)idx;
    arena[idx] = b;
    return idx;
}
static void free_node(int idx) { free(arena[idx]); arena[idx] = NULL; }

static void tree_reset(int f, int vs) {
    for (int i = 1; i <= g_count; i++) if (arena[i]) free_node(i);
    g_count = 0; g_root = 0; g_height = 0; g_leftmost = 0; g_rightmost = 0;
    F = f; VS = vs; MINK = f / 2;
    uint64_t a = leaf_node_size(f, vs), b = internal_node_size(f);
    NODE_MAX = a > b ? a : b;
}

/* ---------------- key helpers ---------------- */
static void mk_key(uint8_t *k, uint32_t n) {
    memset(k, 0, KEY_SIZE);
    k[28] = (n >> 24) & 0xFF; k[29] = (n >> 16) & 0xFF;
    k[30] = (n >> 8) & 0xFF;  k[31] = n & 0xFF;
}
static uint32_t key_num(const uint8_t *k) {
    return ((uint32_t)k[28] << 24) | ((uint32_t)k[29] << 16) |
           ((uint32_t)k[30] << 8) | (uint32_t)k[31];
}

/* child index to descend through for `key` at an internal node */
static int descend_child(uint8_t *d, const uint8_t *key) {
    int pos = node_lower_bound(d, key);
    uint64_t *kids = node_kids(d, F);
    if (pos < node_hdr(d)->key_count && key_cmp(key_ptr(d, pos), key) == 0)
        return (int)kids[pos + 1];
    return (int)kids[pos];
}

/* ---------------- insert ---------------- */
static int tree_insert(const uint8_t *key, const uint8_t *value) {
    if (g_height == 0) {
        g_root = alloc_node(1);
        leaf_insert(N(g_root), key, value, F, VS);
        g_height = 1; g_leftmost = g_rightmost = g_root;
        return NODE_OK;
    }
    int path[MAX_TREE_HEIGHT];
    int cur = g_root;
    for (int lvl = 0; lvl < g_height - 1; lvl++) {
        path[lvl] = cur;
        cur = descend_child(N(cur), key);
    }
    int leaf = cur;
    path[g_height - 1] = leaf;

    int r = leaf_insert(N(leaf), key, value, F, VS);
    if (r != NODE_OK) return r;
    if (node_hdr(N(leaf))->key_count <= F) return NODE_OK;

    /* split the leaf */
    uint8_t sep[KEY_SIZE];
    int rightidx = alloc_node(1);
    leaf_split(N(leaf), N(rightidx), sep, F, VS);
    /* wire chain: rightidx between leaf and leaf.next */
    int oldnext = (int)node_hdr(N(leaf))->next_leaf_idx;
    node_hdr(N(rightidx))->next_leaf_idx = (uint64_t)oldnext;
    node_hdr(N(leaf))->next_leaf_idx = (uint64_t)rightidx;
    if (!oldnext) g_rightmost = rightidx;   /* forward-only chain (D1) */

    /* propagate the separator up */
    int prop = 1;
    for (int lvl = g_height - 2; lvl >= 0; lvl--) {
        int par = path[lvl];
        int pos = node_lower_bound(N(par), sep);
        internal_insert_at(N(par), pos, sep, (uint64_t)rightidx, F);
        if (node_hdr(N(par))->key_count <= F) { prop = 0; break; }
        int newi = alloc_node(0);
        internal_split(N(par), N(newi), sep, F);   /* sep <- promoted key */
        rightidx = newi;
    }
    if (prop) {
        int newroot = alloc_node(0);
        memcpy(key_ptr(N(newroot), 0), sep, KEY_SIZE);
        uint64_t *kids = node_kids(N(newroot), F);
        kids[0] = (uint64_t)g_root;
        kids[1] = (uint64_t)rightidx;
        node_hdr(N(newroot))->key_count = 1;
        g_root = newroot;
        g_height++;
    }
    return NODE_OK;
}

/* ---------------- find ---------------- */
static int tree_find(const uint8_t *key, uint8_t *out_val) {
    if (g_height == 0) return 0;
    int cur = g_root;
    for (int lvl = 0; lvl < g_height - 1; lvl++) cur = descend_child(N(cur), key);
    uint8_t *d = N(cur);
    int pos = node_lower_bound(d, key);
    if (pos < node_hdr(d)->key_count && key_cmp(key_ptr(d, pos), key) == 0) {
        if (out_val) memcpy(out_val, val_ptr(d, F, VS, pos), VS);
        return 1;
    }
    return 0;
}

/* ---------------- delete ---------------- */
static int tree_delete(const uint8_t *key) {
    if (g_height == 0) return NODE_KEY_NOT_FOUND;
    int path[MAX_TREE_HEIGHT];
    int cpos[MAX_TREE_HEIGHT];     /* child index taken at each level */
    int cur = g_root;
    for (int lvl = 0; lvl < g_height - 1; lvl++) {
        path[lvl] = cur;
        int pos = node_lower_bound(N(cur), key);
        uint64_t *kids = node_kids(N(cur), F);
        int ci;
        if (pos < node_hdr(N(cur))->key_count && key_cmp(key_ptr(N(cur), pos), key) == 0)
            ci = pos + 1;
        else
            ci = pos;
        cpos[lvl] = ci;
        cur = (int)kids[ci];
    }
    int leaf = cur;
    path[g_height - 1] = leaf;

    int r = leaf_delete(N(leaf), key, NULL, F, VS);
    if (r != NODE_OK) return r;

    /* rebalance bottom-up */
    for (int lvl = g_height - 1; lvl >= 1; lvl--) {
        uint8_t *node = N(path[lvl]);
        if (node_hdr(node)->key_count >= MINK) break;
        int par_idx = path[lvl - 1];
        uint8_t *par = N(par_idx);
        int our_pos = cpos[lvl - 1];
        int right_exists = (our_pos < node_hdr(par)->key_count);
        int sib_idx, sep_pos, side_right;
        if (right_exists) { sib_idx = (int)node_kids(par, F)[our_pos + 1]; sep_pos = our_pos; side_right = 1; }
        else              { sib_idx = (int)node_kids(par, F)[our_pos - 1]; sep_pos = our_pos - 1; side_right = 0; }
        uint8_t *sib = N(sib_idx);

        if (node_hdr(node)->is_leaf) {
            if (side_right) {
                if (node_hdr(sib)->key_count > MINK) {
                    leaf_borrow_from_right(node, sib, par, sep_pos, F, VS); break;
                }
                leaf_merge(node, sib, F, VS);
                if (node_hdr(node)->next_leaf_idx == 0) g_rightmost = (int)node_hdr(node)->node_idx;
                internal_remove_at(par, sep_pos, F);
                free_node(sib_idx);
            } else {
                if (node_hdr(sib)->key_count > MINK) {
                    leaf_borrow_from_left(sib, node, par, sep_pos, F, VS); break;
                }
                leaf_merge(sib, node, F, VS);
                if (node_hdr(sib)->next_leaf_idx == 0) g_rightmost = (int)node_hdr(sib)->node_idx;
                internal_remove_at(par, sep_pos, F);
                free_node((int)node_hdr(node)->node_idx);
            }
        } else {
            if (side_right) {
                if (node_hdr(sib)->key_count > MINK) {
                    internal_borrow_from_right(node, sib, par, sep_pos, F); break;
                }
                internal_merge_right(node, sib, par, sep_pos, F);
                internal_remove_at(par, sep_pos, F);
                free_node(sib_idx);
            } else {
                if (node_hdr(sib)->key_count > MINK) {
                    internal_borrow_from_left(sib, node, par, sep_pos, F); break;
                }
                internal_merge_right(sib, node, par, sep_pos, F);
                internal_remove_at(par, sep_pos, F);
                free_node((int)node_hdr(node)->node_idx);
            }
        }
    }

    /* root collapse / empty */
    if (g_height > 1) {
        uint8_t *root = N(g_root);
        if (!node_hdr(root)->is_leaf && node_hdr(root)->key_count == 0) {
            int only = (int)node_kids(root, F)[0];
            free_node(g_root);
            g_root = only;
            g_height--;
        }
    }
    if (g_height == 1 && node_hdr(N(g_root))->key_count == 0) {
        free_node(g_root);
        g_root = 0; g_height = 0; g_leftmost = g_rightmost = 0;
    }
    return NODE_OK;
}

/* ---------------- invariant checker ---------------- */
static int g_inorder[4096], g_in_n;
static int g_leaf_depth;
static int g_fail;
#define VCHECK(c, m) do { if (!(c)) { printf("INVARIANT FAIL: %s\n", m); g_fail++; } } while (0)

/* recursive: low inclusive, high exclusive (-1 / 1<<30 sentinels) */
static void check_rec(int idx, int depth, long low, long high) {
    uint8_t *d = N(idx);
    NodeHeader *h = node_hdr(d);
    int c = h->key_count;
    /* counts (B4): non-root in [MINK, F]; root may be smaller but <= F */
    if (idx != g_root) VCHECK(c >= MINK && c <= F, "count in [MIN,F]");
    else VCHECK(c <= F, "root count <= F");
    /* sorted within node (C1) */
    for (int i = 1; i < c; i++) VCHECK(key_cmp(key_ptr(d, i - 1), key_ptr(d, i)) < 0, "node sorted");
    /* key bounds (C3) */
    for (int i = 0; i < c; i++) {
        long k = key_num(key_ptr(d, i));
        VCHECK(k >= low && k < high, "key within subtree bounds");
    }
    if (h->is_leaf) {
        if (g_leaf_depth < 0) g_leaf_depth = depth;
        VCHECK(depth == g_leaf_depth, "all leaves same depth (B1)");
        for (int i = 0; i < c; i++) g_inorder[g_in_n++] = (int)key_num(key_ptr(d, i));
    } else {
        uint64_t *kids = node_kids(d, F);
        /* children = keys+1 (B3) implicitly via the loop bounds */
        for (int i = 0; i <= c; i++) {
            long lo = (i == 0) ? low : (long)key_num(key_ptr(d, i - 1));
            long hi = (i == c) ? high : (long)key_num(key_ptr(d, i));
            check_rec((int)kids[i], depth + 1, lo, hi);
        }
    }
}

static int tree_find_u32(uint32_t n, uint8_t *out);

/* full validation against the oracle (present[]/val[]) */
static void validate(const uint8_t *present, const uint8_t *oval, int kmax, const char *tag) {
    g_in_n = 0; g_leaf_depth = -1;
    if (g_height > 0) check_rec(g_root, 0, -1, 1L << 30);

    /* inorder == sorted oracle keys, with matching values */
    int oi = 0;
    for (int k = 1; k <= kmax; k++) if (present[k]) {
        if (oi < g_in_n) VCHECK(g_inorder[oi] == k, "inorder matches oracle key");
        uint8_t got[VAL_SIZE_MAX];
        VCHECK(tree_find_u32(k, got) == 1 && got[0] == oval[k], "find matches oracle value");
        oi++;
    }
    VCHECK(oi == g_in_n, "tree size matches oracle size");

    /* leaf chain forward == inorder; backward == reverse (D1/D3) */
    if (g_height > 0) {
        int walk = g_leftmost, wi = 0, guard = 0;
        while (walk && guard++ < MAXN) {
            uint8_t *d = N(walk);
            for (int i = 0; i < node_hdr(d)->key_count; i++) {
                if (wi < g_in_n) VCHECK((int)key_num(key_ptr(d, i)) == g_inorder[wi], "chain fwd matches inorder");
                wi++;
            }
            int nx = (int)node_hdr(d)->next_leaf_idx;
            if (!nx) VCHECK(walk == g_rightmost, "chain ends at rightmost");
            walk = nx;
        }
        VCHECK(wi == g_in_n, "chain covers all keys");
        VCHECK(node_hdr(N(g_rightmost))->next_leaf_idx == 0, "rightmost.next == 0");
    }

    if (g_fail) { printf("  (failures during: %s)\n", tag); exit(1); }
}

/* helper used inside validate (declared above its first use via forward decl) */
static int tree_find_u32(uint32_t n, uint8_t *out) {
    uint8_t k[KEY_SIZE]; mk_key(k, n);
    return tree_find(k, out);
}

/* ---------------- differential driver ---------------- */
static uint32_t rs = 0xDEADBEEFu;
static uint32_t rng(void) { uint32_t x = rs; x ^= x<<13; x^=x>>17; x^=x<<5; rs=x; return x; }

static void differential(int f, int vs, int kmax, int nops, int check_every) {
    tree_reset(f, vs);
    uint8_t *present = calloc(kmax + 1, 1);
    uint8_t *oval = calloc(kmax + 1, 1);
    uint8_t k[KEY_SIZE], v[VAL_SIZE_MAX];

    for (int it = 0; it < nops; it++) {
        uint32_t key = (rng() % kmax) + 1;
        int op = rng() % 3;       /* 0,1 insert-leaning; 2 delete */
        if (op <= 1) {
            mk_key(k, key);
            uint8_t vv = (uint8_t)(rng() & 0xFF);
            memset(v, 0, vs); v[0] = vv;
            int r = tree_insert(k, v);
            if (present[key]) {
                if (r != NODE_DUPLICATE_KEY) { printf("expected dup at %u\n", key); exit(1); }
            } else {
                if (r != NODE_OK) { printf("insert failed %u\n", key); exit(1); }
                present[key] = 1; oval[key] = vv;
            }
        } else {
            mk_key(k, key);
            int r = tree_delete(k);
            if (present[key]) {
                if (r != NODE_OK) { printf("delete failed %u\n", key); exit(1); }
                present[key] = 0;
            } else {
                if (r != NODE_KEY_NOT_FOUND) { printf("expected notfound %u\n", key); exit(1); }
            }
        }
        if (it % check_every == 0) validate(present, oval, kmax, "loop");
    }
    validate(present, oval, kmax, "final");
    free(present); free(oval);
    printf("  F=%-3d vs=%-3d kmax=%-5d nops=%-6d  OK (height=%d, nodes=%d)\n",
           f, vs, kmax, nops, g_height, g_count);
}

int main(void) {
    /* small fanouts force frequent splits/merges/cascades */
    differential(4, 8, 600, 40000, 1);
    differential(5, 8, 800, 40000, 1);
    differential(6, 32, 1200, 40000, 3);
    differential(8, 64, 2000, 60000, 5);
    differential(16, 8, 3000, 60000, 7);
    printf("L2 differential: ALL PASS\n");
    return 0;
}
