/*
 * Torna L1 unit tests — pure node ops (host build, TORNA_DEBUG on).
 * Drives leaf_insert/delete/split and internal_insert/split/remove against a
 * sorted-array reference and checks the structural invariants from invariants.md.
 *
 * Build+run:
 *   clang -DTORNA_DEBUG -O1 -Wall -Wextra -o /tmp/test_node torna/test/test_node.c \
 *     && /tmp/test_node
 */
#include "../src/node.h"
#include <stdio.h>
#include <stdlib.h>

static int g_checks = 0, g_fail = 0;
#define CHECK(cond, msg) do { g_checks++; if (!(cond)) { \
    printf("FAIL: %s (line %d)\n", msg, __LINE__); g_fail++; } } while (0)

/* deterministic xorshift PRNG (no libc rand, reproducible) */
static uint32_t rng_state = 0x12345678u;
static uint32_t rng(void) {
    uint32_t x = rng_state;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    rng_state = x; return x;
}

/* 32-byte key holding n big-endian in the low 4 bytes -> numeric == lexicographic */
static void mk_key(uint8_t *k, uint32_t n) {
    memset(k, 0, KEY_SIZE);
    k[28] = (n >> 24) & 0xFF; k[29] = (n >> 16) & 0xFF;
    k[30] = (n >> 8) & 0xFF;  k[31] = n & 0xFF;
}
static uint32_t key_num(const uint8_t *k) {
    return ((uint32_t)k[28] << 24) | ((uint32_t)k[29] << 16) |
           ((uint32_t)k[30] << 8) | (uint32_t)k[31];
}

static uint8_t *new_leaf(int F, int vs) {
    uint8_t *d = calloc(1, leaf_node_size(F, vs));
    node_hdr(d)->is_leaf = 1; node_hdr(d)->initialized = 1;
    return d;
}

/* Assert a leaf's keys are strictly ascending (C1). */
static void check_sorted(uint8_t *d, const char *who) {
    int c = node_hdr(d)->key_count;
    for (int i = 1; i < c; i++)
        CHECK(key_cmp(key_ptr(d, i - 1), key_ptr(d, i)) < 0, who);
}

/* ---------- leaf: random insert keeps sorted order + matches reference ---------- */
static void test_leaf_insert_order(int F, int vs) {
    uint8_t *d = new_leaf(F, vs);
    uint32_t ref[256]; int rc = 0;
    uint8_t k[KEY_SIZE], v[VAL_SIZE_MAX];
    /* insert F distinct keys in random order */
    for (int i = 0; i < F; i++) {
        uint32_t n;
        int dup;
        do {
            n = (rng() % 100000) + 1;
            dup = 0; for (int j = 0; j < rc; j++) if (ref[j] == n) dup = 1;
        } while (dup);
        mk_key(k, n); memset(v, 0, vs); v[0] = (uint8_t)(n & 0xFF);
        int r = leaf_insert(d, k, v, F, vs);
        CHECK(r == NODE_OK, "insert ok");
        ref[rc++] = n;
    }
    CHECK(node_hdr(d)->key_count == F, "count == F");
    check_sorted(d, "leaf order");
    /* sort reference, compare element-wise + value */
    for (int i = 0; i < rc; i++) for (int j = i + 1; j < rc; j++)
        if (ref[j] < ref[i]) { uint32_t t = ref[i]; ref[i] = ref[j]; ref[j] = t; }
    for (int i = 0; i < rc; i++) {
        CHECK(key_num(key_ptr(d, i)) == ref[i], "key matches ref");
        CHECK(val_ptr(d, F, vs, i)[0] == (uint8_t)(ref[i] & 0xFF), "value matches");
    }
    /* duplicate is rejected, count unchanged */
    mk_key(k, ref[0]);
    CHECK(leaf_insert(d, k, v, F, vs) == NODE_DUPLICATE_KEY, "dup rejected");
    CHECK(node_hdr(d)->key_count == F, "count unchanged after dup");
    free(d);
}

/* ---------- leaf: fill to F, insert F+1th, split, check invariants ---------- */
static void test_leaf_split(int F, int vs) {
    uint8_t *d = new_leaf(F, vs);
    uint8_t k[KEY_SIZE], v[VAL_SIZE_MAX]; memset(v, 7, vs);
    /* keys 2,4,6,... so we can insert odd keys between */
    for (int i = 0; i < F; i++) { mk_key(k, (uint32_t)(2 * i + 2)); leaf_insert(d, k, v, F, vs); }
    CHECK(node_hdr(d)->key_count == F, "full leaf");
    /* insert one more -> transient F+1 */
    mk_key(k, 1); leaf_insert(d, k, v, F, vs);
    CHECK(node_hdr(d)->key_count == F + 1, "transient F+1");

    uint8_t *nd = new_leaf(F, vs);
    uint8_t sep[KEY_SIZE];
    leaf_split(d, nd, sep, F, vs);
    int lc = node_hdr(d)->key_count, rc = node_hdr(nd)->key_count;
    CHECK(lc + rc == F + 1, "split conserves count");
    CHECK(rc >= lc, "right gets the larger half");
    check_sorted(d, "left sorted"); check_sorted(nd, "right sorted");
    CHECK(key_cmp(sep, key_ptr(nd, 0)) == 0, "separator == right[0]");
    /* boundary: last(left) < first(right) */
    CHECK(key_cmp(key_ptr(d, lc - 1), key_ptr(nd, 0)) < 0, "left < right ordering");
    free(d); free(nd);
}

/* ---------- leaf: delete keeps order + reference ---------- */
static void test_leaf_delete(int F, int vs) {
    uint8_t *d = new_leaf(F, vs);
    uint8_t k[KEY_SIZE], v[VAL_SIZE_MAX]; memset(v, 0, vs);
    for (int i = 0; i < F; i++) { mk_key(k, (uint32_t)(i + 1)); leaf_insert(d, k, v, F, vs); }
    /* delete every 3rd key */
    int expected = F;
    for (uint32_t n = 1; n <= (uint32_t)F; n += 3) {
        mk_key(k, n);
        CHECK(leaf_delete(d, k, NULL, F, vs) == NODE_OK, "delete ok");
        expected--;
    }
    CHECK(node_hdr(d)->key_count == expected, "count after deletes");
    check_sorted(d, "delete order");
    /* deleted keys are gone, others remain */
    for (uint32_t n = 1; n <= (uint32_t)F; n++) {
        mk_key(k, n);
        int pos = node_lower_bound(d, k);
        int present = (pos < node_hdr(d)->key_count && key_cmp(key_ptr(d, pos), k) == 0);
        int should = ((n - 1) % 3 != 0);
        CHECK(present == should, "membership after delete");
    }
    /* deleting a missing key */
    mk_key(k, 999999);
    CHECK(leaf_delete(d, k, NULL, F, vs) == NODE_KEY_NOT_FOUND, "delete missing");
    free(d);
}

static void test_leaf_update(int F, int vs) {
    uint8_t *d = new_leaf(F, vs);
    uint8_t k[KEY_SIZE], v[VAL_SIZE_MAX]; memset(v, 0, vs);
    for (int i = 0; i < F; i++) { mk_key(k, (uint32_t)(i + 1)); v[0] = (uint8_t)((i + 1) & 0xFF); leaf_insert(d, k, v, F, vs); }
    uint16_t count_before = node_hdr(d)->key_count;
    /* overwrite every key's value with a distinct new byte; key set unchanged */
    for (uint32_t n = 1; n <= (uint32_t)F; n++) {
        mk_key(k, n); memset(v, 0, vs); v[0] = (uint8_t)(~n & 0xFF);
        CHECK(leaf_update(d, k, v, F, vs) == NODE_OK, "update ok");
    }
    CHECK(node_hdr(d)->key_count == count_before, "update keeps key_count");
    check_sorted(d, "update order");
    for (uint32_t n = 1; n <= (uint32_t)F; n++) {
        mk_key(k, n);
        int pos = node_lower_bound(d, k);
        CHECK(pos < node_hdr(d)->key_count && key_cmp(key_ptr(d, pos), k) == 0, "key still present");
        CHECK(val_ptr(d, F, vs, pos)[0] == (uint8_t)(~n & 0xFF), "value overwritten");
    }
    /* updating a missing key changes nothing */
    mk_key(k, 999999); memset(v, 7, vs);
    CHECK(leaf_update(d, k, v, F, vs) == NODE_KEY_NOT_FOUND, "update missing");
    CHECK(node_hdr(d)->key_count == count_before, "missing update keeps count");
    free(d);
}

/* ---------- internal: insert/split/remove ---------- */
static void test_internal(int F) {
    uint8_t *d = calloc(1, internal_node_size(F));
    node_hdr(d)->is_leaf = 0; node_hdr(d)->initialized = 1;
    uint64_t *kids = node_kids(d, F);
    uint8_t k[KEY_SIZE];
    /* seed: keys [10,20,30], children [100,101,102,103] */
    uint32_t seed[3] = {10, 20, 30};
    for (int i = 0; i < 3; i++) { mk_key(k, seed[i]); memcpy(key_ptr(d, i), k, KEY_SIZE); }
    node_hdr(d)->key_count = 3;
    for (int i = 0; i < 4; i++) kids[i] = 100 + i;

    /* insert separator 25 with right child 200 */
    mk_key(k, 25);
    int pos = node_lower_bound(d, k);
    CHECK(pos == 2, "lower_bound(25) == 2");
    internal_insert_at(d, pos, k, 200, F);
    CHECK(node_hdr(d)->key_count == 4, "internal count 4");
    CHECK(key_num(key_ptr(d, 2)) == 25, "key 25 at idx2");
    CHECK(kids[3] == 200, "new child at pos+1");
    CHECK(kids[4] == 103, "old child shifted");
    for (int i = 1; i < 4; i++) CHECK(key_cmp(key_ptr(d, i - 1), key_ptr(d, i)) < 0, "internal sorted");

    /* split [10,20,25,30] -> promote 25 */
    uint8_t *nd = calloc(1, internal_node_size(F));
    node_hdr(nd)->is_leaf = 0; node_hdr(nd)->initialized = 1;
    uint8_t sep[KEY_SIZE];
    internal_split(d, nd, sep, F);
    CHECK(key_num(sep) == 25, "promoted sep == 25");
    CHECK(node_hdr(d)->key_count == 2, "left 2 keys");
    CHECK(node_hdr(nd)->key_count == 1, "right 1 key");
    CHECK(key_num(key_ptr(d, 0)) == 10 && key_num(key_ptr(d, 1)) == 20, "left keys");
    CHECK(key_num(key_ptr(nd, 0)) == 30, "right key");
    /* left children = [100,101,102], right children = [200,103] */
    CHECK(node_kids(d, F)[0] == 100 && node_kids(d, F)[2] == 102, "left kids");
    CHECK(node_kids(nd, F)[0] == 200 && node_kids(nd, F)[1] == 103, "right kids");

    /* remove separator at idx0 of left ([10,20] -> [20]) */
    internal_remove_at(d, 0, F);
    CHECK(node_hdr(d)->key_count == 1, "after remove count 1");
    CHECK(key_num(key_ptr(d, 0)) == 20, "remaining key 20");
    /* removing sep at pos0 drops child[pos+1]=child[1]=101 -> kids [100,102] */
    CHECK(node_kids(d, F)[0] == 100, "child[0] after remove");
    CHECK(node_kids(d, F)[1] == 102, "child[1] after remove");
    free(d); free(nd);
}

/* internal_remove_first: drop kids[0] + keys[0] (CompactLeaf's leftmost removal) */
static void test_internal_remove_first(int F) {
    uint8_t *d = calloc(1, internal_node_size(F));
    node_hdr(d)->is_leaf = 0; node_hdr(d)->initialized = 1;
    uint64_t *kids = node_kids(d, F);
    uint8_t k[KEY_SIZE];
    uint32_t seed[3] = {10, 20, 30};
    for (int i = 0; i < 3; i++) { mk_key(k, seed[i]); memcpy(key_ptr(d, i), k, KEY_SIZE); }
    node_hdr(d)->key_count = 3;
    for (int i = 0; i < 4; i++) kids[i] = 100 + i; /* kids [100,101,102,103] */

    internal_remove_first(d, F); /* drop kids[0]=100, keys[0]=10 */
    CHECK(node_hdr(d)->key_count == 2, "remove_first: count 3->2");
    CHECK(key_num(key_ptr(d, 0)) == 20 && key_num(key_ptr(d, 1)) == 30, "remove_first: keys shifted [20,30]");
    CHECK(kids[0] == 101 && kids[1] == 102 && kids[2] == 103, "remove_first: kids shifted [101,102,103]");
    free(d);
}

int main(void) {
    int Fs[] = {32, 64, 128};
    int vss[] = {1, 8, 64, 128};
    for (unsigned fi = 0; fi < sizeof(Fs)/sizeof(Fs[0]); fi++) {
        for (unsigned vi = 0; vi < sizeof(vss)/sizeof(vss[0]); vi++) {
            test_leaf_insert_order(Fs[fi], vss[vi]);
            test_leaf_split(Fs[fi], vss[vi]);
            test_leaf_delete(Fs[fi], vss[vi]);
            test_leaf_update(Fs[fi], vss[vi]);
        }
        test_internal(Fs[fi]);
        test_internal_remove_first(Fs[fi]);
    }
    printf("checks=%d  failures=%d  -> %s\n", g_checks, g_fail,
           g_fail == 0 ? "ALL PASS" : "FAILURES");
    return g_fail ? 1 : 0;
}
