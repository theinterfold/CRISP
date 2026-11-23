/// Leaves per tree. A public insert hashes up to `MAX_DEPTH` times at ~257k L2 gas each, which has to fit in the 6M
/// AVM transaction limit.
pub global MAX_DEPTH: u32 = 16;
pub global MAX_LEAVES: u32 = 65536;

/// Level `i` holds the root of an empty subtree of height `i` (zk-kit `InternalLazyIMT._defaultZero`).
pub global LAZY_ZEROS: [Field; 17] = [
    0x0000000000000000000000000000000000000000000000000000000000000000,
    0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864,
    0x1069673dcdb12263df301a6ff584a7ec261a44cb9dc68df067a4774460b1f1e1,
    0x18f43331537ee2af2e3d758d50f72106467c6eea50371dd528d57eb2b856d238,
    0x07f9d837cb17b0d36320ffe93ba52345f1b728571a568265caac97559dbc952a,
    0x2b94cf5e8746b3f5c9631f4c5df32907a699c58c94b2ad4d7b5cec1639183f55,
    0x2dee93c5a666459646ea7d22cca9e1bcfed71e6951b953611d11dda32ea09d78,
    0x078295e5a22b84e982cf601eb639597b8b0515a88cb5ac7fa8a4aabe3c87349d,
    0x2fa5e5f18f6027a6501bec864564472a616b2e274a41211a444cbe3a99f3cc61,
    0x0e884376d0d8fd21ecb780389e941f66e45e7acce3e228ab3e2156a614fcd747,
    0x1b7201da72494f1e28717ad1a52eb469f95892f957713533de6175e5da190af2,
    0x1f8d8822725e36385200c0b201249819a6e6e1e4650808b5bebc6bface7d7636,
    0x2c5d82f66c914bafb9701589ba8cfcfb6162b0a12acf88a8d0879a0471b5f85a,
    0x14c54148a0940bb820957f5adf3fa1134ef5c4aaa113f4646458f270e0bfbfd0,
    0x190d33b12f986f961e10c0ee44d8b9af11be25588cad89d416118e4bf4ebe80c,
    0x22f98aa9ce704152ac17354914ad73ed1167ae6596af510aa5b3649325e06c92,
    0x2a7c7c9b6ce5880b9f6f228d72bf6a575a526f29c66ecceef8b753d38bba7323,
];

/// `keccak256("Ballot(uint256 e3Id,address slot,bytes32 ciphertextCommitment)")`
pub global BALLOT_TYPEHASH: [u8; 32] = [
    0x1c, 0x39, 0xe3, 0x41, 0x7a, 0x39, 0x60, 0x7b, 0x63, 0x20, 0xf7, 0xe6, 0xba, 0xe9, 0xdd, 0xb8,
    0xa3, 0xf2, 0xfb, 0x5d, 0x78, 0x43, 0x67, 0xc5, 0x63, 0xc7, 0xdc, 0x98, 0x89, 0x55, 0x7a, 0x3e,
];

/// `keccak256("StagingKey(uint256 e3Id)")`
pub global STAGING_KEY_TYPEHASH: [u8; 32] = [
    0xee, 0x0b, 0xe1, 0x39, 0x92, 0xb8, 0x17, 0xff, 0x38, 0xfc, 0x04, 0x91, 0xa6, 0x3d, 0x9e, 0xb4,
    0x7b, 0x8c, 0x6c, 0xe5, 0x6e, 0xdf, 0x35, 0x78, 0x43, 0x3b, 0x9f, 0xd9, 0x2d, 0xc1, 0x1f, 0xcf,
];

/// `keccak256("InputAvailability(uint256 e3Id,bytes32 inputId,uint64 expiresAt)")`
pub global INPUT_AVAILABILITY_TYPEHASH: [u8; 32] = [
    0x0e, 0xf6, 0x94, 0xfb, 0x5d, 0x94, 0xf5, 0x99, 0xd7, 0xd0, 0xdf, 0x06, 0xcd, 0x71, 0x07, 0x08,
    0x9f, 0xf6, 0x02, 0xe1, 0x78, 0x0e, 0xb8, 0x3f, 0x71, 0x81, 0x9c, 0xe3, 0x3d, 0xfd, 0x8c, 0xd1,
];

/// `"CRISP_INPUT_V1"`, the string `abi.encode`d into the input id.
pub global INPUT_ID_TAG: [u8; 14] = [
    0x43, 0x52, 0x49, 0x53, 0x50, 0x5f, 0x49, 0x4e, 0x50, 0x55, 0x54, 0x5f, 0x56, 0x31,
];

/// Message type words of the L1 <-> L2 messages.
pub global MESSAGE_ROUND: Field = 1;
pub global MESSAGE_KEY: Field = 2;
pub global MESSAGE_ROOT: Field = 3;
/// Type word of the ENROLL message of the votes program (`abi.encode(4, roundId, slot, weight)`).
pub global MESSAGE_ENROLL: Field = 4;

/// `RoundConfig.nationality_mode`: no nationality rule, nationality in the list, nationality not in the list.
pub global NATIONALITY_NONE: u8 = 0;
pub global NATIONALITY_IN: u8 = 1;
pub global NATIONALITY_OUT: u8 = 2;

/// First field of each public log.
pub global LOG_INPUT_COMMITTED: Field = 1;
pub global LOG_MEMBER_REGISTERED: Field = 2;
pub global LOG_ROUND_CLOSED: Field = 3;
pub global LOG_ROUND_OPENED: Field = 4;
pub global LOG_KEY_PUBLISHED: Field = 5;
/// `CrispAztecVotes` only: a staging key was bound (`[round_id, index, slot, commitment, root]`).
pub global LOG_STAGING_KEY_BOUND: Field = 6;
