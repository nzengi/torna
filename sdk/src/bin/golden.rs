//! Emit golden vectors (JSON) from the Rust torna-sdk so the TS SDK can assert
//! byte-for-byte equivalence on the pure surface: order_key, PDAs, init_tree_ix.
//! Run: cargo run --bin golden --offline > ../ts-sdk/vectors/golden.json

use solana_sdk::pubkey::Pubkey;
use torna_sdk::{keys, Tree};

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn main() {
    // deterministic, reproducible across Rust/TS
    let program = Pubkey::new_from_array([1u8; 32]);
    let creator = Pubkey::new_from_array([2u8; 32]);
    let maker = Pubkey::new_from_array([3u8; 32]);
    let tree_id: u32 = 7;
    let t = Tree::new(program, creator, tree_id);

    let cases = [
        (keys::Side::Ask, 100u64, 5u64, 0u64),
        (keys::Side::Ask, 200, 5, 0),
        (keys::Side::Ask, 100, 1, 9),
        (keys::Side::Bid, 100, 5, 0),
        (keys::Side::Bid, 200, 5, 0),
        (keys::Side::Bid, 999, 0, 3),
    ];

    let mut ok = String::from("[");
    for (i, (side, price, slot, nonce)) in cases.iter().enumerate() {
        let k = keys::order_key(*side, *price, *slot, &maker, *nonce);
        if i > 0 { ok.push(','); }
        ok.push_str(&format!(
            "{{\"side\":{},\"price\":{},\"slot\":{},\"nonce\":{},\"hex\":\"{}\"}}",
            *side as u8, price, slot, nonce, hex(&k)
        ));
    }
    ok.push(']');

    let init = t.init_tree_ix(maker, 40, 8, 1000, 500);
    let accts: Vec<String> = init.accounts.iter().map(|a| a.pubkey.to_string()).collect();
    let accts_json = format!("[{}]", accts.iter().map(|s| format!("\"{}\"", s)).collect::<Vec<_>>().join(","));

    println!("{{");
    println!("  \"program\": \"{}\",", program);
    println!("  \"creator\": \"{}\",", creator);
    println!("  \"maker\": \"{}\",", maker);
    println!("  \"treeId\": {},", tree_id);
    println!("  \"orderKeys\": {},", ok);
    println!("  \"pdas\": {{ \"header\": \"{}\", \"alloc\": \"{}\", \"node3\": \"{}\" }},",
             t.header_pda().0, t.alloc_pda().0, t.node_pda(3).0);
    println!("  \"initTreeIx\": {{ \"valueSize\": 40, \"fanout\": 8, \"rentHdr\": 1000, \"rentAlloc\": 500, \"dataHex\": \"{}\", \"accounts\": {} }}",
             hex(&init.data), accts_json);
    println!("}}");
}
