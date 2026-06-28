/*
 * Torna composability probe (MOAT step 1 de-risk).
 *
 * A minimal caller program that forwards a Torna hot-path instruction (InsertFast /
 * DeleteFast -- anything whose accounts are [header, authority, path...]) via CPI,
 * signing as a "book authority" PDA derived from seeds ["book", bump] under THIS
 * program. It proves:
 *   - a program can drive Torna as a PDA authority (invoke_signed),
 *   - the engine accepts a PDA signer exactly like a keypair signer,
 *   - the proxy adds NO shared writable account, so the writable set stays
 *     {fee_payer, leaf} and disjoint-key place/cancel still parallelize through it.
 *
 * accounts: [0] torna_program  [1] book_pda  [2] header(ro)
 *           [3..] path nodes (internals ro, leaf writable)
 * ix data : [bump u8][forwarded torna ix bytes, e.g. 16 | key32 | value | path_len]
 */
#include <solana_sdk.h>

#define MAXA 32

extern uint64_t entrypoint(const uint8_t *input) {
    SolAccountInfo ka[MAXA];
    SolParameters p = (SolParameters){ .ka = ka };
    if (!sol_deserialize(input, &p, MAXA)) return ERROR_INVALID_ARGUMENT;
    if (p.data_len < 2) return ERROR_INVALID_ARGUMENT;
    if (p.ka_num < 4) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;

    uint8_t bump = p.data[0];

    SolAccountMeta metas[MAXA];
    uint64_t m = 0;
    metas[m++] = (SolAccountMeta){ ka[2].key, false, false };        /* header     ro        */
    metas[m++] = (SolAccountMeta){ ka[1].key, false, true  };        /* book PDA   ro, signer */
    uint64_t npath = p.ka_num - 3;
    for (uint64_t i = 0; i < npath; i++) {
        bool leaf = (i == npath - 1);
        metas[m++] = (SolAccountMeta){ ka[3 + i].key, leaf, false }; /* leaf writable, internals ro */
    }

    SolInstruction ix = { ka[0].key, metas, m, (uint8_t *)(p.data + 1), p.data_len - 1 };
    SolSignerSeed seed[2] = { { (const uint8_t *)"book", 4 }, { &bump, 1 } };
    SolSignerSeeds signers[1] = { { seed, 2 } };
    return sol_invoke_signed(&ix, ka, p.ka_num, signers, 1);
}
