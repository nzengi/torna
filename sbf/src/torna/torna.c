/*
 * Torna v4 — SBF program. Wraps the pure node layer (node.h) with account
 * validation, cross-tree binding, and CPI-based node allocation.
 *
 * This increment implements the critical path that proves the architecture
 * on-chain: InitTree (CPI create header + allocator), Insert (descend, leaf
 * insert, split with CPI spare creation, split propagation, root grow), Find,
 * and Stats. Delete / fast paths / range scan follow in the next increment.
 *
 * See torna_docs/design.md for the account model and wire formats.
 */
#include <solana_sdk.h>
#define TORNA_SBF
#include "node.h"

/* ---- constants ---- */
#define TORNA_MAGIC   0x34544254u   /* "TBT4" */
#define ALLOC_MAGIC   0x34434c41u   /* "ALC4" */
#define TORNA_VERSION 4

/* error codes (custom program errors, low 32 bits) */
#define ERR_BAD_MAGIC        100
#define ERR_BAD_NODE         101
#define ERR_NEED_SPLIT_SLOT  102
#define ERR_DUPLICATE_KEY    103
#define ERR_KEY_NOT_FOUND    104
#define ERR_BAD_PATH         105
#define ERR_TREE_INIT_TWICE  106
#define ERR_NOT_WRITABLE     109
#define ERR_NODE_TOO_SMALL   110
#define ERR_BAD_IX_DATA      111
#define ERR_TREE_UNINIT      112
#define ERR_NOT_EMPTY        116
#define ERR_NODE_UNINIT      113
#define ERR_NOT_AUTHORIZED   115
#define ERR_BAD_PARAM        116
#define ERR_DELEGATE_FULL    117
#define ERR_DELEGATE_NOT_FOUND 118
#define ERR_LEAF_NOT_ADJACENT  119
#define ERR_MULTI_LEAF_OVERFLOW 120

#define MAX_MULTI_LEAF_LEAVES 8
#define MAX_MULTI_LEAF_EPL    12

#define DELEGATE_MAGIC     0x34474c44u   /* "DLG4" */
#define SCRATCH_MAGIC      0x34524353u   /* "SCR4" -- RangeScan output buffer */
#define MAX_DELEGATES      8
#define DELEGATE_ACCT_SIZE 512

/* instruction discriminators */
#define IX_INIT_TREE   0
#define IX_INSERT      2
#define IX_FIND        3
#define IX_DELETE      8
#define IX_STATS       5
#define IX_TRANSFER_AUTHORITY 11
#define IX_RANGE_SCAN  4
#define IX_BULK_INSERT_FAST 9
#define IX_ADD_DELEGATE     12
#define IX_REMOVE_DELEGATE  13
#define IX_MULTI_LEAF_INSERT_FAST 14
#define IX_COMPACT     6
#define IX_INSERT_FAST 16
#define IX_UPDATE_FAST 17
#define IX_DELETE_FAST 18

static const SolPubkey SYSTEM_PROGRAM_ID = {{0}};

/* ---- on-account layouts ---- */
typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint16_t version;
    uint16_t flags;
    uint8_t  creator[32];
    uint32_t tree_id;
    uint16_t key_size;
    uint16_t value_size;
    uint16_t fanout;
    uint32_t node_size;
    uint64_t root_node_idx;
    uint32_t height;
    uint64_t leftmost_leaf_idx;
    uint64_t rightmost_leaf_idx;
    uint64_t structure_epoch;
    uint8_t  authority[32];
    uint8_t  tree_uid[16];   /* sha256(creator||tree_id)[..16] -- 128-bit tenant id */
    uint8_t  alloc_bump;     /* allocator PDA bump, for re-derivation in Insert */
    uint8_t  reserved[7];
} TreeHeader;
#define TREE_HEADER_SIZE 146
_Static_assert(sizeof(TreeHeader) == TREE_HEADER_SIZE, "TreeHeader size");

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint32_t tree_id;
    uint64_t node_high_water;
    uint8_t  reserved[16];
} AllocatorAccount;
#define ALLOC_SIZE 32
_Static_assert(sizeof(AllocatorAccount) == ALLOC_SIZE, "Allocator size");

/* Optional side account at PDA("tdlg", creator, tree_id) holding additional
 * signers that may write to the tree. The primary authority is always valid;
 * delegates are additive. */
typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint32_t tree_id;
    uint8_t  bump;
    uint8_t  count;
    uint8_t  reserved[2];
    uint8_t  delegates[MAX_DELEGATES * 32];
    uint8_t  authorizing[32];   /* the authority that owns this list; delegates are
                                 * honored ONLY while this == header.authority, so a
                                 * TransferAuthority invalidates the prior owner's
                                 * delegates (no covert backdoor). */
} DelegateAccount;

/* ===================== ABI FREEZE (see torna_docs/abi.md) =====================
 * These lock the on-account byte layout at compile time. A change here breaks
 * every existing tree on chain, so it must be a DELIBERATE version bump + a
 * migration -- never an accident. KEY_SIZE (32) and NODE_HDR_SIZE (44) are frozen
 * too (in node.h). NodeHeader.tree_uid binds a node to its (creator,tree_id);
 * TreeHeader.reserved[7] + account realloc
 * is the header's extension path; the unused discriminators are the ix extension
 * space; trailing optional ix fields (e.g. RangeScan dir) extend a handler. */
_Static_assert(__builtin_offsetof(TreeHeader, creator)            ==  8, "ABI hdr.creator");
_Static_assert(__builtin_offsetof(TreeHeader, tree_id)            == 40, "ABI hdr.tree_id");
_Static_assert(__builtin_offsetof(TreeHeader, value_size)         == 46, "ABI hdr.value_size");
_Static_assert(__builtin_offsetof(TreeHeader, fanout)             == 48, "ABI hdr.fanout");
_Static_assert(__builtin_offsetof(TreeHeader, node_size)          == 50, "ABI hdr.node_size");
_Static_assert(__builtin_offsetof(TreeHeader, root_node_idx)      == 54, "ABI hdr.root");
_Static_assert(__builtin_offsetof(TreeHeader, height)            == 62, "ABI hdr.height");
_Static_assert(__builtin_offsetof(TreeHeader, leftmost_leaf_idx)  == 66, "ABI hdr.leftmost");
_Static_assert(__builtin_offsetof(TreeHeader, rightmost_leaf_idx) == 74, "ABI hdr.rightmost");
_Static_assert(__builtin_offsetof(TreeHeader, structure_epoch)    == 82, "ABI hdr.epoch");
_Static_assert(__builtin_offsetof(TreeHeader, authority)          == 90, "ABI hdr.authority");
_Static_assert(__builtin_offsetof(TreeHeader, tree_uid)          == 122, "ABI hdr.tree_uid");
_Static_assert(__builtin_offsetof(TreeHeader, alloc_bump)        == 138, "ABI hdr.alloc_bump");
_Static_assert(__builtin_offsetof(NodeHeader, key_count)          ==  2, "ABI node.key_count");
_Static_assert(__builtin_offsetof(NodeHeader, tree_id)            ==  8, "ABI node.tree_id");
_Static_assert(__builtin_offsetof(NodeHeader, node_idx)           == 12, "ABI node.node_idx");
_Static_assert(__builtin_offsetof(NodeHeader, next_leaf_idx)      == 20, "ABI node.next_leaf");
_Static_assert(__builtin_offsetof(NodeHeader, tree_uid)          == 28, "ABI node.tree_uid");
_Static_assert(__builtin_offsetof(AllocatorAccount, node_high_water) == 8, "ABI alloc.hw");
_Static_assert(__builtin_offsetof(DelegateAccount, delegates)     == 12, "ABI dlg.delegates");
_Static_assert(__builtin_offsetof(DelegateAccount, authorizing)  == 268, "ABI dlg.authorizing");
_Static_assert(sizeof(DelegateAccount) == 300, "DelegateAccount size frozen");
_Static_assert(KEY_SIZE == 32 && NODE_HDR_SIZE == 44, "ABI key/node-header sizes frozen");

/* ---- helpers ---- */
static bool tx_has_authority(SolParameters *p, const uint8_t *authority) {
    bool zero = true;
    for (int i = 0; i < 32; i++) if (authority[i]) { zero = false; break; }
    if (zero) return true;
    for (uint64_t i = 0; i < p->ka_num; i++) {
        if (!p->ka[i].is_signer) continue;
        if (sol_memcmp(p->ka[i].key->x, authority, 32) == 0) return true;
    }
    return false;
}

/* Primary authority OR a delegate listed in a validated delegate side account
 * (PDA-checked, magic + tree_id bound). Used by the write handlers. */
static bool tx_has_authorized_signer(SolParameters *p, TreeHeader *th, const SolPubkey *prog) {
    if (tx_has_authority(p, th->authority)) return true;
    for (uint64_t i = 0; i < p->ka_num; i++) {
        SolAccountInfo *acc = &p->ka[i];
        if (acc->data_len < sizeof(DelegateAccount)) continue;
        if (!SolPubkey_same(acc->owner, prog)) continue;
        DelegateAccount *d = (DelegateAccount *)acc->data;
        if (d->magic != DELEGATE_MAGIC || d->tree_id != th->tree_id) continue;
        if (d->count == 0 || d->count > MAX_DELEGATES) continue;
        uint32_t tid = d->tree_id;
        uint8_t bump = d->bump;
        SolSignerSeed seeds[4] = {
            { (const uint8_t *)"tdlg", 4 }, { th->creator, 32 },
            { (const uint8_t *)&tid, 4 }, { (const uint8_t *)&bump, 1 },
        };
        SolPubkey expected;
        if (sol_create_program_address(seeds, 4, prog, &expected) != SUCCESS) continue;
        if (!SolPubkey_same(acc->key, &expected)) continue;
        /* delegates are honored only under the authority that added them; a prior
         * owner's list is stale after TransferAuthority. */
        if (sol_memcmp(d->authorizing, th->authority, 32) != 0) continue;
        for (uint8_t di = 0; di < d->count; di++) {
            const uint8_t *del = &d->delegates[di * 32];
            for (uint64_t si = 0; si < p->ka_num; si++) {
                if (!p->ka[si].is_signer) continue;
                if (sol_memcmp(p->ka[si].key->x, del, 32) == 0) return true;
            }
        }
    }
    return false;
}

static uint64_t check_header(SolAccountInfo *a, const SolPubkey *prog, bool need_w) {
    if (a->data_len < TREE_HEADER_SIZE) return ERR_NODE_TOO_SMALL;
    if (need_w && !a->is_writable) return ERR_NOT_WRITABLE;
    if (!SolPubkey_same(a->owner, prog)) return ERROR_INCORRECT_PROGRAM_ID;
    TreeHeader *h = (TreeHeader *)a->data;
    if (h->magic != TORNA_MAGIC) return ERR_BAD_MAGIC;
    if (h->version != TORNA_VERSION) return ERR_BAD_PARAM;  /* migration-safety (T8.2) */
    return SUCCESS;
}

/* Validate a node account: program-owned, big enough, initialized, identity and
 * TENANT binding match. need_w toggles the writable requirement. tree_uid binds
 * the node to its (creator,tree_id) -- tree_id alone collides across creators. */
static uint64_t check_node(SolAccountInfo *a, const SolPubkey *prog, uint32_t node_size,
                           uint64_t expect_idx, const uint8_t *tree_uid, bool need_w) {
    if (a->data_len < node_size) return ERR_NODE_TOO_SMALL;
    if (need_w && !a->is_writable) return ERR_NOT_WRITABLE;
    if (!SolPubkey_same(a->owner, prog)) return ERROR_INCORRECT_PROGRAM_ID;
    NodeHeader *h = node_hdr(a->data);
    if (!h->initialized) return ERR_NODE_UNINIT;
    if (h->node_idx != expect_idx) return ERR_BAD_PATH;
    if (sol_memcmp(h->tree_uid, tree_uid, 16) != 0) return ERR_BAD_PATH;   /* anti cross-tenant splice */
    return SUCCESS;
}

/* CPI system::create_account for `acc`, signed by `seeds`, owned by us. */
static uint64_t cpi_create(SolParameters *p, SolAccountInfo *payer, SolAccountInfo *acc,
                           uint64_t lamports, uint64_t space,
                           const SolSignerSeed *seeds, int n_seeds) {
    uint8_t d[52];
    sol_memset(d, 0, 4);
    *(uint64_t *)&d[4]  = lamports;
    *(uint64_t *)&d[12] = space;
    sol_memcpy(&d[20], p->program_id->x, 32);
    SolAccountMeta metas[2] = {
        { payer->key, true, true },
        { acc->key,   true, true },
    };
    SolInstruction ix = { (SolPubkey *)&SYSTEM_PROGRAM_ID, metas, 2, d, sizeof(d) };
    SolSignerSeeds signers[1] = { { seeds, (uint64_t)n_seeds } };
    return sol_invoke_signed(&ix, p->ka, p->ka_num, signers, 1);
}

/* Allocate one spare node via CPI and initialize its header. */
static uint64_t consume_spare(SolParameters *p, int payer_idx, int spare_idx,
                              TreeHeader *th, AllocatorAccount *al,
                              uint8_t is_leaf, uint16_t level, uint8_t bump,
                              uint64_t rent, uint64_t *out_idx) {
    SolAccountInfo *spare = &p->ka[spare_idx];
    if (!spare->is_writable) return ERR_NOT_WRITABLE;
    if (spare->data_len != 0) return ERR_TREE_INIT_TWICE;

    uint64_t new_idx = al->node_high_water + 1;
    uint32_t tid = th->tree_id;
    SolSignerSeed seeds[5] = {
        { (const uint8_t *)"tnode", 5 },
        { th->creator, 32 },
        { (const uint8_t *)&tid, 4 },
        { (const uint8_t *)&new_idx, 8 },
        { (const uint8_t *)&bump, 1 },
    };
    uint64_t err = cpi_create(p, &p->ka[payer_idx], spare, rent, th->node_size, seeds, 5);
    if (err) return err;

    NodeHeader *h = node_hdr(spare->data);
    h->is_leaf = is_leaf; h->initialized = 1; h->key_count = 0;
    h->level = level; h->_pad = 0;
    h->tree_id = th->tree_id; h->node_idx = new_idx;
    h->next_leaf_idx = 0; sol_memcpy(h->tree_uid, th->tree_uid, 16);
    al->node_high_water = new_idx;
    *out_idx = new_idx;
    return SUCCESS;
}

/* ======================= InitTree ======================= */
/* ix: [0]disc [1..5)tree_id [5]hdr_bump [6]alloc_bump [7..9)value_size
 *     [9..11)fanout [11..19)rent_hdr [19..27)rent_alloc
 * accounts: [0]payer(s,w) [1]header(w) [2]alloc(w) [3]system_program */
/* Tenant id = low 16 bytes of sha256(creator || tree_id). Unforgeable across
 * creators (a 128-bit second-preimage grind is infeasible), so it makes (creator,tree_id)
 * the real node-tenant identity that check_node enforces. */
static void tree_uid_of(const uint8_t *creator, uint32_t tree_id, uint8_t *out16) {
    SolBytes segs[2] = { { creator, 32 }, { (const uint8_t *)&tree_id, 4 } };
    uint8_t h[32];
    sol_sha256(segs, 2, h);
    sol_memcpy(out16, h, 16);   /* 128-bit tenant id */
}

static uint64_t do_init_tree(SolParameters *p) {
    if (p->ka_num < 4) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;
    if (p->data_len < 27) return ERR_BAD_IX_DATA;
    uint32_t tree_id    = *(uint32_t *)(p->data + 1);
    uint8_t  hdr_bump   = p->data[5];
    uint8_t  alloc_bump = p->data[6];
    uint16_t value_size = *(uint16_t *)(p->data + 7);
    uint16_t fanout     = *(uint16_t *)(p->data + 9);
    uint64_t rent_hdr   = *(uint64_t *)(p->data + 11);
    uint64_t rent_alloc = *(uint64_t *)(p->data + 19);

    if (value_size < 1 || value_size > VAL_SIZE_MAX) return ERR_BAD_PARAM;
    if (fanout < 4 || fanout > 256) return ERR_BAD_PARAM;

    SolAccountInfo *payer = &p->ka[0];
    SolAccountInfo *hdr   = &p->ka[1];
    SolAccountInfo *alloc = &p->ka[2];
    if (!payer->is_signer) return ERROR_MISSING_REQUIRED_SIGNATURES;
    if (hdr->data_len != 0 || alloc->data_len != 0) return ERR_TREE_INIT_TWICE;

    uint64_t lsz = leaf_node_size(fanout, value_size);
    uint64_t isz = internal_node_size(fanout);
    uint32_t node_size = (uint32_t)(lsz > isz ? lsz : isz);

    /* create header PDA: ["thdr", creator, tree_id, hdr_bump] */
    {
        SolSignerSeed s[4] = {
            { (const uint8_t *)"thdr", 4 }, { payer->key->x, 32 },
            { (const uint8_t *)&tree_id, 4 }, { (const uint8_t *)&hdr_bump, 1 },
        };
        uint64_t e = cpi_create(p, payer, hdr, rent_hdr, TREE_HEADER_SIZE, s, 4);
        if (e) return e;
    }
    /* create allocator PDA: ["talloc", creator, tree_id, alloc_bump] */
    {
        SolSignerSeed s[4] = {
            { (const uint8_t *)"talloc", 6 }, { payer->key->x, 32 },
            { (const uint8_t *)&tree_id, 4 }, { (const uint8_t *)&alloc_bump, 1 },
        };
        uint64_t e = cpi_create(p, payer, alloc, rent_alloc, ALLOC_SIZE, s, 4);
        if (e) return e;
    }

    TreeHeader *th = (TreeHeader *)hdr->data;
    sol_memset(hdr->data, 0, TREE_HEADER_SIZE);
    th->magic = TORNA_MAGIC; th->version = TORNA_VERSION; th->flags = 0;
    sol_memcpy(th->creator, payer->key->x, 32);
    th->tree_id = tree_id; th->key_size = KEY_SIZE; th->value_size = value_size;
    th->fanout = fanout; th->node_size = node_size;
    th->root_node_idx = 0; th->height = 0;
    th->leftmost_leaf_idx = 0; th->rightmost_leaf_idx = 0; th->structure_epoch = 0;
    sol_memcpy(th->authority, payer->key->x, 32);
    tree_uid_of(payer->key->x, tree_id, th->tree_uid);
    th->alloc_bump = alloc_bump;

    AllocatorAccount *al = (AllocatorAccount *)alloc->data;
    sol_memset(alloc->data, 0, ALLOC_SIZE);
    al->magic = ALLOC_MAGIC; al->tree_id = tree_id; al->node_high_water = 0;

    sol_log("torna: init_tree ok");
    return SUCCESS;
}

/* ======================= Insert ======================= */
/* ix: [0]disc [1..33)key [33..33+vs)value [33+vs]path_len [34+vs]spare_count
 *     [35+vs..43+vs)rent_node [43+vs..]bumps[spare_count]
 * accounts: [0]header(w) [1]payer(s,w) [2]alloc(w) [3]sysprog
 *           [4..4+path_len) path  [4+path_len..) spares */
static uint64_t do_insert(SolParameters *p) {
    if (p->ka_num < 4) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;
    uint64_t e = check_header(&p->ka[0], p->program_id, true);
    if (e) return e;
    TreeHeader *th = (TreeHeader *)p->ka[0].data;
    int F = th->fanout, vs = th->value_size;
    uint32_t node_size = th->node_size;

    uint64_t min = 1 + KEY_SIZE + (uint64_t)vs + 1 + 1 + 8;
    if (p->data_len < min) return ERR_BAD_IX_DATA;
    const uint8_t *key   = p->data + 1;
    const uint8_t *value = p->data + 1 + KEY_SIZE;
    uint8_t path_len     = p->data[1 + KEY_SIZE + vs];
    uint8_t spare_count  = p->data[2 + KEY_SIZE + vs];
    uint64_t rent_node   = *(uint64_t *)(p->data + 3 + KEY_SIZE + vs);
    const uint8_t *bumps = p->data + 11 + KEY_SIZE + vs;
    if (p->data_len < (uint64_t)(11 + KEY_SIZE + vs) + spare_count) return ERR_BAD_IX_DATA;

    if (!p->ka[1].is_signer) return ERROR_MISSING_REQUIRED_SIGNATURES;
    if (!tx_has_authorized_signer(p, th, p->program_id)) return ERR_NOT_AUTHORIZED;
    if (path_len != th->height) return ERR_BAD_PATH;
    if (path_len > MAX_TREE_HEIGHT) return ERR_BAD_PATH;
    if (p->ka_num < (uint64_t)4 + path_len + spare_count) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;

    /* Validate the allocator like any other account: program-owned, big enough,
     * writable, magic, AND bound to THIS tree by re-deriving its creator-namespaced
     * PDA (tree_id alone collides across creators -- same class as the node fix). */
    SolAccountInfo *al_acc = &p->ka[2];
    if (al_acc->data_len < ALLOC_SIZE) return ERR_NODE_TOO_SMALL;
    if (!al_acc->is_writable) return ERR_NOT_WRITABLE;
    if (!SolPubkey_same(al_acc->owner, p->program_id)) return ERROR_INCORRECT_PROGRAM_ID;
    AllocatorAccount *al = (AllocatorAccount *)al_acc->data;
    if (al->magic != ALLOC_MAGIC || al->tree_id != th->tree_id) return ERR_BAD_MAGIC;
    {
        uint32_t tid = th->tree_id;
        uint8_t  ab  = th->alloc_bump;
        SolSignerSeed s[4] = {
            { (const uint8_t *)"talloc", 6 }, { th->creator, 32 },
            { (const uint8_t *)&tid, 4 }, { (const uint8_t *)&ab, 1 },
        };
        SolPubkey expected;
        if (sol_create_program_address(s, 4, p->program_id, &expected) != SUCCESS) return ERR_BAD_PATH;
        if (!SolPubkey_same(al_acc->key, &expected)) return ERR_BAD_PATH;  /* allocator must be this tree's */
    }
    uint32_t path_base = 4;
    uint32_t spare_base = 4 + (uint32_t)path_len;
    int spare_used = 0;

    /* empty tree: first insert allocates the leaf root */
    if (th->height == 0) {
        if (spare_count < 1) return ERR_NEED_SPLIT_SLOT;
        uint64_t nidx;
        e = consume_spare(p, 1, spare_base, th, al, 1, 0, bumps[0], rent_node, &nidx);
        if (e) return e;
        SolAccountInfo *leaf = &p->ka[spare_base];
        if (leaf_insert(leaf->data, key, value, F, vs) != NODE_OK) return ERR_DUPLICATE_KEY;
        th->root_node_idx = nidx; th->height = 1;
        th->leftmost_leaf_idx = nidx; th->rightmost_leaf_idx = nidx;
        th->structure_epoch++;
        sol_log("torna: first insert");
        return SUCCESS;
    }

    /* descend, validating every node (identity + tree binding) */
    SolAccountInfo *root = &p->ka[path_base];
    e = check_node(root, p->program_id, node_size, th->root_node_idx, th->tree_uid, true);
    if (e) return e;
    for (int lvl = 0; lvl < path_len - 1; lvl++) {
        SolAccountInfo *cur = &p->ka[path_base + lvl];
        NodeHeader *ch = node_hdr(cur->data);
        if (ch->is_leaf) return ERR_BAD_PATH;
        int pos = node_lower_bound(cur->data, key);
        uint64_t *kids = node_kids(cur->data, F);
        uint64_t desc = (pos < ch->key_count && key_cmp(key_ptr(cur->data, pos), key) == 0)
                        ? kids[pos + 1] : kids[pos];
        e = check_node(&p->ka[path_base + lvl + 1], p->program_id, node_size, desc, th->tree_uid, true);
        if (e) return e;
    }
    SolAccountInfo *leaf_acc = &p->ka[path_base + path_len - 1];
    if (!node_hdr(leaf_acc->data)->is_leaf) return ERR_BAD_PATH;

    int r = leaf_insert(leaf_acc->data, key, value, F, vs);
    if (r == NODE_DUPLICATE_KEY) return ERR_DUPLICATE_KEY;

    if (node_hdr(leaf_acc->data)->key_count <= F) return SUCCESS;  /* no split */

    /* split the leaf into a fresh spare and wire the chain */
    if (spare_used >= spare_count) return ERR_NEED_SPLIT_SLOT;
    uint8_t sep[KEY_SIZE];
    uint64_t right_idx;
    e = consume_spare(p, 1, spare_base + spare_used, th, al, 1, 0, bumps[spare_used], rent_node, &right_idx);
    if (e) return e;
    SolAccountInfo *right = &p->ka[spare_base + spare_used];
    spare_used++;
    leaf_split(leaf_acc->data, right->data, sep, F, vs);
    NodeHeader *lh = node_hdr(leaf_acc->data);
    NodeHeader *rh = node_hdr(right->data);
    rh->next_leaf_idx = lh->next_leaf_idx;
    lh->next_leaf_idx = rh->node_idx;
    if (rh->next_leaf_idx == 0) th->rightmost_leaf_idx = rh->node_idx;
    /* chain is forward-only (D1); the new right node's tree_uid is set by
     * consume_spare. */

    /* propagate the separator up the path */
    int prop = 1;
    for (int lvl = path_len - 2; lvl >= 0; lvl--) {
        SolAccountInfo *par = &p->ka[path_base + lvl];
        int pos = node_lower_bound(par->data, sep);
        internal_insert_at(par->data, pos, sep, right_idx, F);
        if (node_hdr(par->data)->key_count <= F) { prop = 0; break; }
        if (spare_used >= spare_count) return ERR_NEED_SPLIT_SLOT;
        uint64_t newi;
        e = consume_spare(p, 1, spare_base + spare_used, th, al, 0, 0, bumps[spare_used], rent_node, &newi);
        if (e) return e;
        SolAccountInfo *ni = &p->ka[spare_base + spare_used];
        spare_used++;
        internal_split(par->data, ni->data, sep, F);
        right_idx = newi;
    }
    if (prop) {
        if (spare_used >= spare_count) return ERR_NEED_SPLIT_SLOT;
        if (th->height >= MAX_TREE_HEIGHT) return ERR_BAD_PATH;  /* fail-closed, never grow past the cap */
        uint64_t newroot;
        e = consume_spare(p, 1, spare_base + spare_used, th, al, 0, 0, bumps[spare_used], rent_node, &newroot);
        if (e) return e;
        SolAccountInfo *nr = &p->ka[spare_base + spare_used];
        spare_used++;
        sol_memcpy(key_ptr(nr->data, 0), sep, KEY_SIZE);
        uint64_t *kids = node_kids(nr->data, F);
        kids[0] = th->root_node_idx; kids[1] = right_idx;
        node_hdr(nr->data)->key_count = 1;
        th->root_node_idx = newroot; th->height++;
        sol_log("torna: tree grew");
    }
    th->structure_epoch++;
    return SUCCESS;
}

/* Close a program-owned account: drain lamports to `to` and zero its data. The
 * runtime garbage-collects an account with 0 lamports. */
static void close_account(SolAccountInfo *a, SolAccountInfo *to) {
    *to->lamports = *to->lamports + *a->lamports;
    *a->lamports = 0;
    sol_memset(a->data, 0, a->data_len);
}

/* ======================= Delete (full rebalance) =======================
 * ix: [8][key32][path_len][sibling_sides[path_len]]   (0=none,1=right,2=left)
 * accounts: [0]header(w) [1]payer(s,w) [2..2+path_len) path(w)
 *           [2+path_len..) siblings in level order, skipping levels with side 0 (w)
 * Cascade is bottom-up: borrow if the sibling has > MIN, else merge + close. A
 * root that ends with 0 keys collapses (height shrinks); an emptied leaf-root
 * leaves height 0. Closed-node rent goes to the payer. */
static uint64_t do_delete(SolParameters *p) {
    if (p->ka_num < 3) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;
    uint64_t e = check_header(&p->ka[0], p->program_id, true);
    if (e) return e;
    TreeHeader *th = (TreeHeader *)p->ka[0].data;
    int F = th->fanout, vs = th->value_size, MINK = F / 2;
    uint32_t ns = th->node_size;
    if (p->data_len < 1 + KEY_SIZE + 1) return ERR_BAD_IX_DATA;
    const uint8_t *key = p->data + 1;
    uint8_t path_len = p->data[1 + KEY_SIZE];
    if (path_len == 0 || path_len > MAX_TREE_HEIGHT) return ERR_BAD_PATH;
    if (p->data_len < (uint64_t)(1 + KEY_SIZE + 1 + path_len)) return ERR_BAD_IX_DATA;
    const uint8_t *sides = p->data + 2 + KEY_SIZE;

    if (!p->ka[1].is_signer) return ERROR_MISSING_REQUIRED_SIGNATURES;
    /* PRIMARY-only: the rebalancing Delete closes nodes and drains their rent to
     * the payer, so we do not let a delegate trigger it (delegates use DeleteFast
     * for hot-path deletes). */
    if (!tx_has_authority(p, th->authority)) return ERR_NOT_AUTHORIZED;
    if (path_len != th->height) return ERR_BAD_PATH;

    int n_sib = 0;
    for (int i = 0; i < path_len; i++) if (sides[i]) n_sib++;
    if (p->ka_num < (uint64_t)2 + path_len + n_sib) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;

    uint32_t pb = 2;
    uint32_t sb = 2 + (uint32_t)path_len;
    SolAccountInfo *payer = &p->ka[1];

    /* validate descent path */
    e = check_node(&p->ka[pb], p->program_id, ns, th->root_node_idx, th->tree_uid, true);
    if (e) return e;
    for (int lvl = 0; lvl < path_len - 1; lvl++) {
        SolAccountInfo *cur = &p->ka[pb + lvl];
        NodeHeader *ch = node_hdr(cur->data);
        if (ch->is_leaf) return ERR_BAD_PATH;
        int pos = node_lower_bound(cur->data, key);
        uint64_t *kids = node_kids(cur->data, F);
        uint64_t desc = (pos < ch->key_count && key_cmp(key_ptr(cur->data, pos), key) == 0)
                        ? kids[pos + 1] : kids[pos];
        e = check_node(&p->ka[pb + lvl + 1], p->program_id, ns, desc, th->tree_uid, true);
        if (e) return e;
    }
    SolAccountInfo *leaf = &p->ka[pb + path_len - 1];
    if (!node_hdr(leaf->data)->is_leaf) return ERR_BAD_PATH;
    if (leaf_delete(leaf->data, key, NULL, F, vs) == NODE_KEY_NOT_FOUND) return ERR_KEY_NOT_FOUND;

    /* sibling account offsets in level order */
    int sib_off[MAX_TREE_HEIGHT];
    { int o = 0; for (int i = 0; i < path_len; i++) sib_off[i] = sides[i] ? o++ : -1; }

    for (int lvl = path_len - 1; lvl >= 1; lvl--) {
        SolAccountInfo *node = &p->ka[pb + lvl];
        if (node_hdr(node->data)->key_count >= MINK) break;
        /* this level underflowed but the client supplied no sibling for it -- every
         * non-root node has a sibling, so this is a malformed request, not a stop. */
        if (sides[lvl] == 0) return ERR_BAD_PATH;
        SolAccountInfo *par = &p->ka[pb + lvl - 1];
        NodeHeader *ph = node_hdr(par->data);
        uint64_t *pk = node_kids(par->data, F);

        int our_pos = -1;
        for (int i = 0; i <= ph->key_count; i++)
            if (pk[i] == node_hdr(node->data)->node_idx) { our_pos = i; break; }
        if (our_pos < 0) return ERR_BAD_PATH;

        int sib_pos = (sides[lvl] == 1) ? our_pos + 1 : our_pos - 1;
        if (sib_pos < 0 || sib_pos > ph->key_count) return ERR_BAD_PATH;
        SolAccountInfo *sib = &p->ka[sb + sib_off[lvl]];
        e = check_node(sib, p->program_id, ns, pk[sib_pos], th->tree_uid, true);
        if (e) return e;
        bool node_leaf = node_hdr(node->data)->is_leaf;

        if (sides[lvl] == 1) {           /* right sibling, separator at our_pos */
            int sep = our_pos;
            if (node_hdr(sib->data)->key_count > MINK) {
                if (node_leaf) leaf_borrow_from_right(node->data, sib->data, par->data, sep, F, vs);
                else           internal_borrow_from_right(node->data, sib->data, par->data, sep, F);
                break;
            }
            if (node_leaf) {
                leaf_merge(node->data, sib->data, F, vs);
                if (node_hdr(node->data)->next_leaf_idx == 0) th->rightmost_leaf_idx = node_hdr(node->data)->node_idx;
                internal_remove_at(par->data, sep, F);
                close_account(sib, payer);
            } else {
                internal_merge_right(node->data, sib->data, par->data, sep, F);
                internal_remove_at(par->data, sep, F);
                close_account(sib, payer);
            }
        } else {                          /* left sibling, separator at our_pos-1 */
            int sep = our_pos - 1;
            if (node_hdr(sib->data)->key_count > MINK) {
                if (node_leaf) leaf_borrow_from_left(sib->data, node->data, par->data, sep, F, vs);
                else           internal_borrow_from_left(sib->data, node->data, par->data, sep, F);
                break;
            }
            if (node_leaf) {
                leaf_merge(sib->data, node->data, F, vs);
                if (node_hdr(sib->data)->next_leaf_idx == 0) th->rightmost_leaf_idx = node_hdr(sib->data)->node_idx;
                internal_remove_at(par->data, sep, F);
                close_account(node, payer);
            } else {
                internal_merge_right(sib->data, node->data, par->data, sep, F);
                internal_remove_at(par->data, sep, F);
                close_account(node, payer);
            }
        }
    }

    /* root collapse: internal root with 0 keys -> promote its only child */
    if (path_len > 1) {
        SolAccountInfo *root = &p->ka[pb];
        NodeHeader *rh = node_hdr(root->data);
        if (!rh->is_leaf && rh->key_count == 0) {
            th->root_node_idx = node_kids(root->data, F)[0];
            th->height--;
            close_account(root, payer);
        }
    }
    /* emptied leaf root -> empty tree */
    if (path_len == 1 && node_hdr(leaf->data)->key_count == 0) {
        th->height = 0; th->root_node_idx = 0;
        th->leftmost_leaf_idx = 0; th->rightmost_leaf_idx = 0;
        close_account(leaf, payer);
    }
    th->structure_epoch++;
    return SUCCESS;
}

/* ======================= CompactLeaf (keeper, primary only) ===================
 * Reclaim an EMPTY leftmost leaf left behind by DeleteFast sweeps: drop it from its
 * parent, advance leftmost, and close it (rent -> payer). v1 requires the parent to
 * have slack (key_count > MIN) so there is no merge cascade; a keeper calls it
 * repeatedly to walk leftmost forward. Matching already SKIPS empty leaves, so this
 * is rent/space reclaim, not a correctness requirement.
 * ix: [6][path_len u8]   (path = root..leaf, the all-kids[0] leftmost chain)
 * accounts: [0]header(w) [1]payer(s,w) [2..2+path_len) path(w) */
static uint64_t do_compact_leaf(SolParameters *p) {
    if (p->ka_num < 3) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;
    uint64_t e = check_header(&p->ka[0], p->program_id, true);
    if (e) return e;
    TreeHeader *th = (TreeHeader *)p->ka[0].data;
    int F = th->fanout, MINK = F / 2;
    uint32_t ns = th->node_size;
    if (p->data_len < 2) return ERR_BAD_IX_DATA;
    uint8_t path_len = p->data[1];
    if (!p->ka[1].is_signer) return ERROR_MISSING_REQUIRED_SIGNATURES;
    if (!tx_has_authority(p, th->authority)) return ERR_NOT_AUTHORIZED; /* primary only (drains rent) */
    if (th->height < 2) return ERR_BAD_PATH;        /* need a parent: a leaf-root can't compact */
    if (path_len != th->height) return ERR_BAD_PATH;
    if (p->ka_num < (uint64_t)2 + path_len) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;

    /* validate the leftmost descent: each internal step takes kids[0] */
    e = check_node(&p->ka[2], p->program_id, ns, th->root_node_idx, th->tree_uid, true);
    if (e) return e;
    for (int lvl = 0; lvl < path_len - 1; lvl++) {
        SolAccountInfo *cur = &p->ka[2 + lvl];
        if (node_hdr(cur->data)->is_leaf) return ERR_BAD_PATH;
        uint64_t desc = node_kids(cur->data, F)[0]; /* leftmost child */
        e = check_node(&p->ka[2 + lvl + 1], p->program_id, ns, desc, th->tree_uid, true);
        if (e) return e;
    }
    SolAccountInfo *leaf = &p->ka[2 + path_len - 1];
    SolAccountInfo *parent = &p->ka[2 + path_len - 2];
    NodeHeader *lh = node_hdr(leaf->data);
    if (!lh->is_leaf) return ERR_BAD_PATH;
    if (lh->node_idx != th->leftmost_leaf_idx) return ERR_BAD_PATH; /* must be the leftmost */
    if (lh->key_count != 0) return ERR_NOT_EMPTY;                   /* only empty leaves */
    if (node_hdr(parent->data)->key_count <= MINK) return ERR_NEED_SPLIT_SLOT; /* no cascade in v1 */

    uint64_t new_leftmost = lh->next_leaf_idx;     /* read before close */
    internal_remove_first(parent->data, F);        /* drop kids[0]=leaf + keys[0] */
    th->leftmost_leaf_idx = new_leftmost;
    th->structure_epoch++;
    close_account(leaf, &p->ka[1]);                /* rent -> payer */
    return SUCCESS;
}

/* ======================= Find ======================= */
/* ix: [0]disc [1..33)key [33]path_len
 * accounts: [0]header(ro) [1..1+path_len) path
 * return_data: [found u8][value vs] */
static uint64_t do_find(SolParameters *p) {
    if (p->ka_num < 1) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;
    uint64_t e = check_header(&p->ka[0], p->program_id, false);
    if (e) return e;
    TreeHeader *th = (TreeHeader *)p->ka[0].data;
    int F = th->fanout, vs = th->value_size;
    uint32_t node_size = th->node_size;
    if (p->data_len < 1 + KEY_SIZE + 1) return ERR_BAD_IX_DATA;
    const uint8_t *key = p->data + 1;
    uint8_t path_len = p->data[1 + KEY_SIZE];

    uint8_t out[1 + VAL_SIZE_MAX];
    sol_memset(out, 0, 1 + (uint64_t)vs);
    if (th->height == 0) { sol_set_return_data(out, 1 + (uint64_t)vs); return SUCCESS; }
    if (path_len != th->height) return ERR_BAD_PATH;
    if (p->ka_num < (uint64_t)1 + path_len) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;

    SolAccountInfo *root = &p->ka[1];
    e = check_node(root, p->program_id, node_size, th->root_node_idx, th->tree_uid, false);
    if (e) return e;
    for (int lvl = 0; lvl < path_len - 1; lvl++) {
        SolAccountInfo *cur = &p->ka[1 + lvl];
        NodeHeader *ch = node_hdr(cur->data);
        if (ch->is_leaf) return ERR_BAD_PATH;
        int pos = node_lower_bound(cur->data, key);
        uint64_t *kids = node_kids(cur->data, F);
        uint64_t desc = (pos < ch->key_count && key_cmp(key_ptr(cur->data, pos), key) == 0)
                        ? kids[pos + 1] : kids[pos];
        e = check_node(&p->ka[1 + lvl + 1], p->program_id, node_size, desc, th->tree_uid, false);
        if (e) return e;
    }
    SolAccountInfo *leaf = &p->ka[1 + path_len - 1];
    if (!node_hdr(leaf->data)->is_leaf) return ERR_BAD_PATH;
    int pos = node_lower_bound(leaf->data, key);
    if (pos < node_hdr(leaf->data)->key_count && key_cmp(key_ptr(leaf->data, pos), key) == 0) {
        out[0] = 1;
        sol_memcpy(out + 1, val_ptr(leaf->data, F, vs, pos), vs);
    }
    sol_set_return_data(out, 1 + (uint64_t)vs);
    return SUCCESS;
}

/* ======================= Stats ======================= */
static uint64_t do_stats(SolParameters *p) {
    if (p->ka_num < 1) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;
    uint64_t e = check_header(&p->ka[0], p->program_id, false);
    if (e) return e;
    sol_set_return_data(p->ka[0].data, TREE_HEADER_SIZE);
    return SUCCESS;
}

/* Read-only descend over path [base .. base+path_len). Validates every node's
 * identity + tree binding; returns the leaf account in *out_leaf. */
static uint64_t descend_ro(SolParameters *p, TreeHeader *th, uint32_t base,
                           uint8_t path_len, const uint8_t *key, SolAccountInfo **out_leaf) {
    int F = th->fanout;
    uint32_t ns = th->node_size;
    uint64_t e = check_node(&p->ka[base], p->program_id, ns, th->root_node_idx, th->tree_uid, false);
    if (e) return e;
    for (int lvl = 0; lvl < path_len - 1; lvl++) {
        SolAccountInfo *cur = &p->ka[base + lvl];
        NodeHeader *ch = node_hdr(cur->data);
        if (ch->is_leaf) return ERR_BAD_PATH;
        int pos = node_lower_bound(cur->data, key);
        uint64_t *kids = node_kids(cur->data, F);
        uint64_t desc = (pos < ch->key_count && key_cmp(key_ptr(cur->data, pos), key) == 0)
                        ? kids[pos + 1] : kids[pos];
        e = check_node(&p->ka[base + lvl + 1], p->program_id, ns, desc, th->tree_uid, false);
        if (e) return e;
    }
    SolAccountInfo *leaf = &p->ka[base + path_len - 1];
    if (!node_hdr(leaf->data)->is_leaf) return ERR_BAD_PATH;
    *out_leaf = leaf;
    return SUCCESS;
}

/* True if `key` descends through path[base..base+path_len) to the path's leaf.
 * The batch fast paths descend with a batch's FIRST key; they must also confirm
 * the batch's LAST key still routes to the same leaf, or a key past the leaf's
 * upper separator would be silently inserted into the wrong leaf. */
static bool path_routes_to_leaf(SolParameters *p, int F, uint32_t base,
                                uint8_t path_len, const uint8_t *key) {
    for (int lvl = 0; lvl < path_len - 1; lvl++) {
        uint8_t *cur = p->ka[base + lvl].data;
        int pos = node_lower_bound(cur, key);
        uint64_t *kids = node_kids(cur, F);
        uint64_t desc = (pos < node_hdr(cur)->key_count && key_cmp(key_ptr(cur, pos), key) == 0)
                        ? kids[pos + 1] : kids[pos];
        if (node_hdr(p->ka[base + lvl + 1].data)->node_idx != desc) return false;
    }
    return true;
}

/* ======================= InsertFast (hot path, no CPI) =======================
 * Header READ-ONLY, only the target leaf writable -> two fast inserts to
 * different leaves carry disjoint write sets and parallelize. Refuses if the
 * leaf would overflow (caller retries with full Insert).
 * ix: [16][key32][value vs][path_len]
 * accounts: [0]header(ro) [1]authority(s,ro) [2..2+path_len) path (leaf writable) */
static uint64_t do_insert_fast(SolParameters *p) {
    if (p->ka_num < 2) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;
    uint64_t e = check_header(&p->ka[0], p->program_id, false);
    if (e) return e;
    TreeHeader *th = (TreeHeader *)p->ka[0].data;
    int F = th->fanout, vs = th->value_size;
    if (p->data_len < (uint64_t)(1 + KEY_SIZE + vs + 1)) return ERR_BAD_IX_DATA;
    const uint8_t *key = p->data + 1;
    const uint8_t *value = p->data + 1 + KEY_SIZE;
    uint8_t path_len = p->data[1 + KEY_SIZE + vs];
    if (!tx_has_authorized_signer(p, th, p->program_id)) return ERR_NOT_AUTHORIZED;
    if (path_len == 0) return ERR_TREE_UNINIT;
    if (path_len != th->height) return ERR_BAD_PATH;
    if (p->ka_num < (uint64_t)2 + path_len) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;

    SolAccountInfo *leaf;
    e = descend_ro(p, th, 2, path_len, key, &leaf);
    if (e) return e;
    if (!leaf->is_writable) return ERR_NOT_WRITABLE;
    if (node_hdr(leaf->data)->key_count >= F) return ERR_NEED_SPLIT_SLOT;
    if (leaf_insert(leaf->data, key, value, F, vs) == NODE_DUPLICATE_KEY) return ERR_DUPLICATE_KEY;
    return SUCCESS;
}

/* ======================= UpdateFast (hot path, value-only) ===================
 * Overwrite the value of an EXISTING key in place. Same key -> no reorder, no
 * key_count change, no split/merge: header read-only, only the leaf writable, no
 * CPI, so disjoint-key updates parallelize exactly like InsertFast. The caller
 * enforces any value policy (e.g. an order's size may only decrease).
 * ix: [17][key32][value vs][path_len]
 * accounts: [0]header(ro) [1]authority(s,ro) [2..) path (leaf writable) */
static uint64_t do_update_fast(SolParameters *p) {
    if (p->ka_num < 2) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;
    uint64_t e = check_header(&p->ka[0], p->program_id, false);
    if (e) return e;
    TreeHeader *th = (TreeHeader *)p->ka[0].data;
    int F = th->fanout, vs = th->value_size;
    if (p->data_len < (uint64_t)(1 + KEY_SIZE + vs + 1)) return ERR_BAD_IX_DATA;
    const uint8_t *key = p->data + 1;
    const uint8_t *value = p->data + 1 + KEY_SIZE;
    uint8_t path_len = p->data[1 + KEY_SIZE + vs];
    if (!tx_has_authorized_signer(p, th, p->program_id)) return ERR_NOT_AUTHORIZED;
    if (path_len == 0) return ERR_TREE_UNINIT;
    if (path_len != th->height) return ERR_BAD_PATH;
    if (p->ka_num < (uint64_t)2 + path_len) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;

    SolAccountInfo *leaf;
    e = descend_ro(p, th, 2, path_len, key, &leaf);   /* validates tree_uid + path */
    if (e) return e;
    if (!leaf->is_writable) return ERR_NOT_WRITABLE;
    if (leaf_update(leaf->data, key, value, F, vs) == NODE_KEY_NOT_FOUND) return ERR_KEY_NOT_FOUND;
    return SUCCESS;
}

/* ======================= DeleteFast (hot path, no rebalance) =================
 * ix: [18][key32][path_len]
 * accounts: [0]header(ro) [1]authority(s,ro) [2..) path (leaf writable)
 * return_data: [found u8][value vs] or [0] */
static uint64_t do_delete_fast(SolParameters *p) {
    if (p->ka_num < 2) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;
    uint64_t e = check_header(&p->ka[0], p->program_id, false);
    if (e) return e;
    TreeHeader *th = (TreeHeader *)p->ka[0].data;
    int F = th->fanout, vs = th->value_size;
    if (p->data_len < 1 + KEY_SIZE + 1) return ERR_BAD_IX_DATA;
    const uint8_t *key = p->data + 1;
    uint8_t path_len = p->data[1 + KEY_SIZE];
    if (!tx_has_authorized_signer(p, th, p->program_id)) return ERR_NOT_AUTHORIZED;
    if (path_len == 0) return ERR_TREE_UNINIT;
    if (path_len != th->height) return ERR_BAD_PATH;
    if (p->ka_num < (uint64_t)2 + path_len) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;

    SolAccountInfo *leaf;
    e = descend_ro(p, th, 2, path_len, key, &leaf);
    if (e) return e;
    if (!leaf->is_writable) return ERR_NOT_WRITABLE;
    uint8_t outv[VAL_SIZE_MAX];
    if (leaf_delete(leaf->data, key, outv, F, vs) == NODE_KEY_NOT_FOUND) {
        uint8_t z[1] = {0};
        sol_set_return_data(z, 1);
        return SUCCESS;
    }
    uint8_t ret[1 + VAL_SIZE_MAX];
    ret[0] = 1;
    sol_memcpy(ret + 1, outv, vs);
    sol_set_return_data(ret, 1 + (uint64_t)vs);
    return SUCCESS;
}

/* ======================= TransferAuthority =======================
 * ix: [11][new_authority 32]
 * accounts: [0]header(w), [1]current_authority(signer,ro)
 * Transfer to all-zero is forbidden (would silently open the tree -> threat T2.5). */
static uint64_t do_transfer_authority(SolParameters *p) {
    if (p->ka_num < 2) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;
    if (p->data_len < 1 + 32) return ERR_BAD_IX_DATA;
    uint64_t e = check_header(&p->ka[0], p->program_id, true);
    if (e) return e;
    TreeHeader *th = (TreeHeader *)p->ka[0].data;
    if (!tx_has_authority(p, th->authority)) return ERR_NOT_AUTHORIZED; /* primary only */
    const uint8_t *new_auth = p->data + 1;
    bool zero = true;
    for (int i = 0; i < 32; i++) if (new_auth[i]) { zero = false; break; }
    if (zero) return ERR_BAD_PARAM;   /* refuse to open the tree by accident */
    sol_memcpy(th->authority, new_auth, 32);
    sol_log("torna: authority transferred");
    return SUCCESS;
}

/* ======================= RangeScan (forward or reverse) =================
 * dir 0 (forward): keys in [start, end] ascending, start <= end.
 * dir 1 (reverse): keys in [end, start] descending, start >= end. Subsequent
 *   leaves are PREDECESSORS supplied in reverse chain order; each is validated by
 *   predecessor.next_leaf_idx == current.node_idx, so NO prev pointer is needed
 *   in the tree (the doubly-linked invariant is relaxed to forward-only).
 * Output goes to a caller-provided PROGRAM-OWNED scratch account (return_data
 * caps at 1024; see design.md s6).
 * ix: [4][start32][end32][start_path_len][max u16][dir u8 (optional, default 0)]
 * accounts: [0]header(ro) [1]scratch(w, program-owned) [2..2+spl) path to the
 *   start leaf [2+spl..) subsequent chain leaves in scan order
 * scratch on return: [SCRATCH_MAGIC u32][count u16][(key32 || value vs) * count] */
static uint64_t do_range_scan(SolParameters *p) {
    if (p->ka_num < 2) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;
    uint64_t e = check_header(&p->ka[0], p->program_id, false);
    if (e) return e;
    TreeHeader *th = (TreeHeader *)p->ka[0].data;
    int F = th->fanout, vs = th->value_size;
    uint32_t ns = th->node_size;
    if (p->data_len < 1 + 2 * KEY_SIZE + 1 + 2) return ERR_BAD_IX_DATA;
    const uint8_t *start = p->data + 1;
    const uint8_t *end   = p->data + 1 + KEY_SIZE;
    uint8_t spl          = p->data[1 + 2 * KEY_SIZE];
    uint32_t max_results = *(uint16_t *)(p->data + 2 + 2 * KEY_SIZE);
    uint8_t dir = (p->data_len > (uint64_t)(4 + 2 * KEY_SIZE)) ? p->data[4 + 2 * KEY_SIZE] : 0;

    /* scratch layout: [SCRATCH_MAGIC u32][count u16][(key||value)*]. owner==program
     * is NOT enough -- the program owns every tree's accounts, so a raw scratch could
     * be a victim's header/node and RangeScan would corrupt it. We accept ONLY a blank
     * account (all-zero first word) or one already stamped SCRATCH_MAGIC; every live
     * Torna account (TORNA/ALLOC/DELEGATE magic, or a node whose first word is
     * is_leaf|init<<8|...) is neither, so it is rejected. (A dedicated magic also
     * avoids aliasing the count into the rejection test.) */
    SolAccountInfo *scratch = &p->ka[1];
    if (!SolPubkey_same(scratch->owner, p->program_id)) return ERROR_INCORRECT_PROGRAM_ID;
    if (!scratch->is_writable) return ERR_NOT_WRITABLE;
    if (scratch->data_len < 6) return ERR_NODE_TOO_SMALL;  /* magic(4) + count(2) header */
    uint32_t sm = *(const uint32_t *)scratch->data;
    if (sm != 0 && sm != SCRATCH_MAGIC) return ERR_BAD_PATH;
    uint64_t entry = (uint64_t)KEY_SIZE + vs;
    uint64_t cap = (scratch->data_len - 6) / entry;
    if (max_results > cap) max_results = (uint32_t)cap;

    uint32_t count = 0;
    if (th->height == 0 || max_results == 0) {
        *(uint32_t *)scratch->data = SCRATCH_MAGIC;
        *(uint16_t *)(scratch->data + 4) = 0;
        return SUCCESS;
    }
    if (spl == 0 || spl != th->height) return ERR_BAD_PATH;
    if (p->ka_num < (uint64_t)2 + spl) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;

    SolAccountInfo *cur;
    e = descend_ro(p, th, 2, spl, start, &cur);
    if (e) return e;
    uint64_t extra_pos = 2 + (uint64_t)spl;

    if (dir == 0) {
        int idx = node_lower_bound(cur->data, start);
        while (1) {
            NodeHeader *ch = node_hdr(cur->data);
            for (; idx < ch->key_count && count < max_results; idx++) {
                uint8_t *k = key_ptr(cur->data, idx);
                if (key_cmp(k, end) > 0) goto done;
                uint64_t off = 6 + (uint64_t)count * entry;
                sol_memcpy(scratch->data + off, k, KEY_SIZE);
                sol_memcpy(scratch->data + off + KEY_SIZE, val_ptr(cur->data, F, vs, idx), vs);
                count++;
            }
            if (count >= max_results) break;
            uint64_t next = node_hdr(cur->data)->next_leaf_idx;
            if (next == 0 || extra_pos >= p->ka_num) break;
            SolAccountInfo *nxt = &p->ka[extra_pos++];
            e = check_node(nxt, p->program_id, ns, next, th->tree_uid, false);
            if (e) return e;
            if (!node_hdr(nxt->data)->is_leaf) return ERR_BAD_PATH;
            cur = nxt; idx = 0;
        }
    } else {
        int lb = node_lower_bound(cur->data, start);
        int idx = (lb < node_hdr(cur->data)->key_count &&
                   key_cmp(key_ptr(cur->data, lb), start) == 0) ? lb : lb - 1;
        while (1) {
            for (; idx >= 0 && count < max_results; idx--) {
                uint8_t *k = key_ptr(cur->data, idx);
                if (key_cmp(k, end) < 0) goto done;
                uint64_t off = 6 + (uint64_t)count * entry;
                sol_memcpy(scratch->data + off, k, KEY_SIZE);
                sol_memcpy(scratch->data + off + KEY_SIZE, val_ptr(cur->data, F, vs, idx), vs);
                count++;
            }
            if (count >= max_results) break;
            if (extra_pos >= p->ka_num) break;
            SolAccountInfo *prev = &p->ka[extra_pos++];
            if (!SolPubkey_same(prev->owner, p->program_id)) return ERROR_INCORRECT_PROGRAM_ID;
            if (prev->data_len < ns) return ERR_NODE_TOO_SMALL;
            NodeHeader *prh = node_hdr(prev->data);
            if (!prh->initialized || !prh->is_leaf) return ERR_BAD_PATH;
            if (sol_memcmp(prh->tree_uid, th->tree_uid, 16) != 0) return ERR_BAD_PATH;
            if (prh->next_leaf_idx != node_hdr(cur->data)->node_idx) return ERR_BAD_PATH; /* predecessor check */
            cur = prev; idx = prh->key_count - 1;
        }
    }
done:
    *(uint32_t *)scratch->data = SCRATCH_MAGIC;
    *(uint16_t *)(scratch->data + 4) = (uint16_t)count;
    return SUCCESS;
}

/* ======================= BulkInsertFast (market-maker primitive) ===========
 * Insert N pre-sorted keys into ONE leaf in a single tx; refuses on overflow.
 * Header read-only, only the leaf writable -> parallel with other leaves.
 * ix: [9][path_len][count][(key32 || value vs) * count]
 * accounts: [0]header(ro) [1]authority(s,ro) [2..2+path_len) path (leaf writable)
 *           (+ an optional delegate account anywhere for delegate-authorized writes) */
static uint64_t do_bulk_insert_fast(SolParameters *p) {
    if (p->data_len < 1 + 1 + 1) return ERR_BAD_IX_DATA;
    if (p->ka_num < 2) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;
    uint64_t e = check_header(&p->ka[0], p->program_id, false);
    if (e) return e;
    TreeHeader *th = (TreeHeader *)p->ka[0].data;
    int F = th->fanout, vs = th->value_size;
    uint8_t path_len = p->data[1];
    uint8_t count    = p->data[2];
    if (count == 0) return SUCCESS;
    uint64_t entry = (uint64_t)KEY_SIZE + vs;
    if (p->data_len < (uint64_t)3 + (uint64_t)count * entry) return ERR_BAD_IX_DATA;
    if (!tx_has_authorized_signer(p, th, p->program_id)) return ERR_NOT_AUTHORIZED;
    if (path_len == 0) return ERR_TREE_UNINIT;
    if (path_len != th->height) return ERR_BAD_PATH;
    if (p->ka_num < (uint64_t)2 + path_len) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;

    const uint8_t *first_key = p->data + 3;
    SolAccountInfo *leaf;
    e = descend_ro(p, th, 2, path_len, first_key, &leaf);
    if (e) return e;
    if (!leaf->is_writable) return ERR_NOT_WRITABLE;
    if ((uint32_t)node_hdr(leaf->data)->key_count + count > F) return ERR_NEED_SPLIT_SLOT;
    /* the batch's last key must route to this same leaf (else a key above the
     * leaf's upper separator would be inserted into the wrong leaf). */
    const uint8_t *last_key = p->data + 3 + (uint64_t)(count - 1) * entry;
    if (!path_routes_to_leaf(p, F, 2, path_len, last_key)) return ERR_BAD_PATH;

    for (uint8_t i = 0; i < count; i++) {
        const uint8_t *k = p->data + 3 + (uint64_t)i * entry;
        const uint8_t *v = k + KEY_SIZE;
        if (i > 0) {
            const uint8_t *pk = p->data + 3 + (uint64_t)(i - 1) * entry;
            if (key_cmp(pk, k) >= 0) return ERR_BAD_IX_DATA;   /* must be strictly ascending */
        }
        if (leaf_insert(leaf->data, k, v, F, vs) == NODE_DUPLICATE_KEY) return ERR_DUPLICATE_KEY;
    }
    return SUCCESS;
}

/* ======================= AddDelegate (primary only) =======================
 * ix: [12][delegate32][bump][rent u64]
 * accounts: [0]header(ro) [1]payer(s,w) [2]delegate_acct(w) [3]system_program */
static uint64_t do_add_delegate(SolParameters *p) {
    if (p->data_len < 1 + 32 + 1 + 8) return ERR_BAD_IX_DATA;
    if (p->ka_num < 4) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;
    uint64_t e = check_header(&p->ka[0], p->program_id, false);
    if (e) return e;
    TreeHeader *th = (TreeHeader *)p->ka[0].data;
    if (!tx_has_authority(p, th->authority)) return ERR_NOT_AUTHORIZED;  /* primary only */
    SolAccountInfo *payer = &p->ka[1];
    SolAccountInfo *del   = &p->ka[2];
    const uint8_t *new_del = p->data + 1;
    uint8_t  bump = p->data[33];
    uint64_t rent = *(uint64_t *)(p->data + 34);
    uint32_t tree_id = th->tree_id;

    if (del->data_len == 0) {
        SolSignerSeed s[4] = {
            { (const uint8_t *)"tdlg", 4 }, { th->creator, 32 },
            { (const uint8_t *)&tree_id, 4 }, { (const uint8_t *)&bump, 1 },
        };
        e = cpi_create(p, payer, del, rent, DELEGATE_ACCT_SIZE, s, 4);
        if (e) return e;
        DelegateAccount *d = (DelegateAccount *)del->data;
        sol_memset(del->data, 0, DELEGATE_ACCT_SIZE);
        d->magic = DELEGATE_MAGIC; d->tree_id = tree_id; d->bump = bump; d->count = 0;
    } else {
        if (del->data_len < sizeof(DelegateAccount)) return ERR_NODE_TOO_SMALL;
        if (!SolPubkey_same(del->owner, p->program_id)) return ERROR_INCORRECT_PROGRAM_ID;
        DelegateAccount *d = (DelegateAccount *)del->data;
        if (d->magic != DELEGATE_MAGIC) return ERR_BAD_MAGIC;
        if (d->tree_id != tree_id) return ERR_BAD_PATH;
    }
    DelegateAccount *d = (DelegateAccount *)del->data;
    /* tenant-bind the delegate account: re-derive its creator-namespaced PDA. Without
     * this, an attacker (primary on their own same-tree_id tree) could pass a victim's
     * delegate account and inject themselves as a delegate -> write to the victim's
     * tree. (Same "program-owned != tenant-owned" class as the node/scratch fixes.) */
    {
        uint8_t bmp = d->bump;
        SolSignerSeed s[4] = {
            { (const uint8_t *)"tdlg", 4 }, { th->creator, 32 },
            { (const uint8_t *)&tree_id, 4 }, { (const uint8_t *)&bmp, 1 },
        };
        SolPubkey expected;
        if (sol_create_program_address(s, 4, p->program_id, &expected) != SUCCESS) return ERR_BAD_PATH;
        if (!SolPubkey_same(del->key, &expected)) return ERR_BAD_PATH;
    }
    /* If the authority changed since this list was last touched (e.g. after a
     * TransferAuthority), the prior owner's delegates are stale -- clear them and
     * restamp, so the new authority starts from a clean slate. */
    if (sol_memcmp(d->authorizing, th->authority, 32) != 0) {
        d->count = 0;
        sol_memcpy(d->authorizing, th->authority, 32);
    }
    for (uint8_t i = 0; i < d->count; i++)
        if (sol_memcmp(&d->delegates[i * 32], new_del, 32) == 0) return SUCCESS;  /* idempotent */
    if (d->count >= MAX_DELEGATES) return ERR_DELEGATE_FULL;
    sol_memcpy(&d->delegates[(uint64_t)d->count * 32], new_del, 32);
    d->count++;
    sol_log("torna: delegate added");
    return SUCCESS;
}

/* ======================= RemoveDelegate (primary only) =======================
 * ix: [13][delegate32]
 * accounts: [0]header(ro) [1]primary(s,ro) [2]delegate_acct(w) */
static uint64_t do_remove_delegate(SolParameters *p) {
    if (p->data_len < 1 + 32) return ERR_BAD_IX_DATA;
    if (p->ka_num < 3) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;
    uint64_t e = check_header(&p->ka[0], p->program_id, false);
    if (e) return e;
    TreeHeader *th = (TreeHeader *)p->ka[0].data;
    if (!tx_has_authority(p, th->authority)) return ERR_NOT_AUTHORIZED;  /* primary only */
    SolAccountInfo *del = &p->ka[2];
    if (del->data_len < sizeof(DelegateAccount)) return ERR_NODE_TOO_SMALL;
    if (!SolPubkey_same(del->owner, p->program_id)) return ERROR_INCORRECT_PROGRAM_ID;
    DelegateAccount *d = (DelegateAccount *)del->data;
    if (d->magic != DELEGATE_MAGIC) return ERR_BAD_MAGIC;
    if (d->tree_id != th->tree_id) return ERR_BAD_PATH;
    {   /* tenant-bind: re-derive the delegate PDA (see do_add_delegate) */
        uint32_t tid = th->tree_id; uint8_t bmp = d->bump;
        SolSignerSeed s[4] = {
            { (const uint8_t *)"tdlg", 4 }, { th->creator, 32 },
            { (const uint8_t *)&tid, 4 }, { (const uint8_t *)&bmp, 1 },
        };
        SolPubkey expected;
        if (sol_create_program_address(s, 4, p->program_id, &expected) != SUCCESS) return ERR_BAD_PATH;
        if (!SolPubkey_same(del->key, &expected)) return ERR_BAD_PATH;
    }
    /* stale list after a TransferAuthority -> nothing of the prior owner's to remove */
    if (sol_memcmp(d->authorizing, th->authority, 32) != 0) return ERR_DELEGATE_NOT_FOUND;

    const uint8_t *target = p->data + 1;
    int found = -1;
    for (uint8_t i = 0; i < d->count; i++)
        if (sol_memcmp(&d->delegates[i * 32], target, 32) == 0) { found = (int)i; break; }
    if (found < 0) return ERR_DELEGATE_NOT_FOUND;
    for (uint8_t i = (uint8_t)found; i + 1 < d->count; i++)
        sol_memcpy(&d->delegates[(uint64_t)i * 32], &d->delegates[(uint64_t)(i + 1) * 32], 32);
    sol_memset(&d->delegates[(uint64_t)(d->count - 1) * 32], 0, 32);
    d->count--;
    sol_log("torna: delegate removed");
    return SUCCESS;
}

/* ======================= MultiLeafInsertFast (atomic cross-leaf) ============
 * Place entries into N ADJACENT leaves in one tx. Header read-only, only the
 * leaves writable -> parallel with disjoint leaf sets. Atomic: any failure
 * reverts every write. Three phases: validate-all, then write-all, so a capacity
 * or ordering problem never leaves a partial apply.
 * ix: [14][path_len][leaf_count][epl[leaf_count]][(key32||value vs) * total]
 * accounts: [0]header(ro) [1]authority(s,ro) then leaf_count blocks of path_len
 *   accounts each (internals ro shared/deduped, the block's last account = leaf w). */
static uint64_t do_multi_leaf_insert_fast(SolParameters *p) {
    if (p->data_len < 3) return ERR_BAD_IX_DATA;
    uint8_t path_len   = p->data[1];
    uint8_t leaf_count = p->data[2];
    if (leaf_count == 0) return SUCCESS;
    if (leaf_count > MAX_MULTI_LEAF_LEAVES) return ERR_MULTI_LEAF_OVERFLOW;
    if (path_len == 0) return ERR_TREE_UNINIT;
    if (p->data_len < (uint64_t)3 + leaf_count) return ERR_BAD_IX_DATA;
    const uint8_t *epl = p->data + 3;
    uint32_t total = 0;
    for (uint8_t li = 0; li < leaf_count; li++) {
        if (epl[li] == 0 || epl[li] > MAX_MULTI_LEAF_EPL) return ERR_MULTI_LEAF_OVERFLOW;
        total += epl[li];
    }
    if (p->ka_num < (uint64_t)2 + (uint64_t)leaf_count * path_len) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;

    uint64_t e = check_header(&p->ka[0], p->program_id, false);
    if (e) return e;
    TreeHeader *th = (TreeHeader *)p->ka[0].data;
    int F = th->fanout, vs = th->value_size;
    uint32_t ns = th->node_size;
    if (!tx_has_authorized_signer(p, th, p->program_id)) return ERR_NOT_AUTHORIZED;
    if (path_len != th->height) return ERR_BAD_PATH;
    uint64_t entry = (uint64_t)KEY_SIZE + vs;
    uint64_t entries_off = (uint64_t)3 + leaf_count;
    if (p->data_len < entries_off + (uint64_t)total * entry) return ERR_BAD_IX_DATA;

    /* ---- phase 1: validate paths, capacity, adjacency, ordering ---- */
    uint64_t cursor = entries_off;
    uint64_t prev_next = 0;
    const uint8_t *prev_last = NULL;
    for (uint8_t li = 0; li < leaf_count; li++) {
        uint8_t n = epl[li];
        uint32_t pbase = 2 + (uint32_t)li * path_len;
        const uint8_t *first_key = p->data + cursor;

        e = check_node(&p->ka[pbase], p->program_id, ns, th->root_node_idx, th->tree_uid, false);
        if (e) return e;
        for (int lvl = 0; lvl < path_len - 1; lvl++) {
            SolAccountInfo *cur = &p->ka[pbase + lvl];
            NodeHeader *ch = node_hdr(cur->data);
            if (ch->is_leaf) return ERR_BAD_PATH;
            int pos = node_lower_bound(cur->data, first_key);
            uint64_t *kids = node_kids(cur->data, F);
            uint64_t desc = (pos < ch->key_count && key_cmp(key_ptr(cur->data, pos), first_key) == 0)
                            ? kids[pos + 1] : kids[pos];
            e = check_node(&p->ka[pbase + lvl + 1], p->program_id, ns, desc, th->tree_uid, false);
            if (e) return e;
        }
        SolAccountInfo *leaf = &p->ka[pbase + path_len - 1];
        NodeHeader *lh = node_hdr(leaf->data);
        if (!lh->is_leaf) return ERR_BAD_PATH;
        if (!leaf->is_writable) return ERR_NOT_WRITABLE;
        if ((uint32_t)lh->key_count + n > F) return ERR_NEED_SPLIT_SLOT;
        if (li > 0 && lh->node_idx != prev_next) return ERR_LEAF_NOT_ADJACENT;
        prev_next = lh->next_leaf_idx;
        /* the block's last key must route to this same leaf (wrong-leaf guard) */
        const uint8_t *block_last = p->data + cursor + (uint64_t)(n - 1) * entry;
        if (!path_routes_to_leaf(p, F, pbase, path_len, block_last)) return ERR_BAD_PATH;

        for (uint8_t ei = 0; ei < n; ei++) {
            const uint8_t *k = p->data + cursor + (uint64_t)ei * entry;
            if (ei == 0 && prev_last && key_cmp(prev_last, k) >= 0) return ERR_BAD_IX_DATA;
            if (ei > 0) {
                const uint8_t *pk = p->data + cursor + (uint64_t)(ei - 1) * entry;
                if (key_cmp(pk, k) >= 0) return ERR_BAD_IX_DATA;
            }
        }
        prev_last = p->data + cursor + (uint64_t)(n - 1) * entry;
        cursor += (uint64_t)n * entry;
    }

    /* ---- phase 2: write (only ERR_DUPLICATE_KEY can still abort, atomically) ---- */
    cursor = entries_off;
    for (uint8_t li = 0; li < leaf_count; li++) {
        uint8_t n = epl[li];
        uint32_t pbase = 2 + (uint32_t)li * path_len;
        SolAccountInfo *leaf = &p->ka[pbase + path_len - 1];
        for (uint8_t ei = 0; ei < n; ei++) {
            const uint8_t *k = p->data + cursor + (uint64_t)ei * entry;
            const uint8_t *v = k + KEY_SIZE;
            if (leaf_insert(leaf->data, k, v, F, vs) == NODE_DUPLICATE_KEY) return ERR_DUPLICATE_KEY;
        }
        cursor += (uint64_t)n * entry;
    }
    return SUCCESS;
}

/* ======================= entrypoint ======================= */
#define MAX_ACCOUNTS 40
extern uint64_t entrypoint(const uint8_t *input) {
    SolAccountInfo accounts[MAX_ACCOUNTS];
    SolParameters params = (SolParameters){ .ka = accounts };
    if (!sol_deserialize(input, &params, MAX_ACCOUNTS)) return ERROR_INVALID_ARGUMENT;
    if (params.data_len < 1) return ERR_BAD_IX_DATA;
    switch (params.data[0]) {
        case IX_INIT_TREE: return do_init_tree(&params);
        case IX_INSERT:    return do_insert(&params);
        case IX_FIND:      return do_find(&params);
        case IX_DELETE:    return do_delete(&params);
        case IX_RANGE_SCAN: return do_range_scan(&params);
        case IX_STATS:     return do_stats(&params);
        case IX_TRANSFER_AUTHORITY: return do_transfer_authority(&params);
        case IX_BULK_INSERT_FAST: return do_bulk_insert_fast(&params);
        case IX_ADD_DELEGATE:     return do_add_delegate(&params);
        case IX_REMOVE_DELEGATE:  return do_remove_delegate(&params);
        case IX_MULTI_LEAF_INSERT_FAST: return do_multi_leaf_insert_fast(&params);
        case IX_COMPACT:     return do_compact_leaf(&params);
        case IX_INSERT_FAST: return do_insert_fast(&params);
        case IX_UPDATE_FAST: return do_update_fast(&params);
        case IX_DELETE_FAST: return do_delete_fast(&params);
        default:           return ERR_BAD_IX_DATA;
    }
}
