use utils::types::{DiscloseMask, MRZData};

// ICAO 9303 MRZ layouts. Passports are TD3 (2 lines x 44 chars, zero-padded to
// the canonical 90-byte disclose payload); ID cards are TD1 (3 x 30 = 90 exactly).
// Offsets mirror @zkpassport/utils (passport/getters.ts).
pub global MRZ_DOC_TYPE_INDEX: u32 = 0; // document code bytes [0..2), both layouts
global ISSUING_COUNTRY_INDEX: u32 = 2; // both layouts
global TD1_DOCUMENT_NUMBER_INDEX: u32 = 5;
global TD1_BIRTHDATE_INDEX: u32 = 30;
global TD1_GENDER_INDEX: u32 = 37;
global TD1_EXPIRY_DATE_INDEX: u32 = 38;
global TD1_NATIONALITY_INDEX: u32 = 45; // ID cards
global TD1_NAME_INDEX: u32 = 60;
global TD1_NAME_LENGTH: u32 = 30;
global TD3_NAME_INDEX: u32 = 5;
global TD3_NAME_LENGTH: u32 = 39;
global TD3_DOCUMENT_NUMBER_INDEX: u32 = 44;
pub global TD3_NATIONALITY_INDEX: u32 = 54; // passports
global TD3_BIRTHDATE_INDEX: u32 = 57;
global TD3_GENDER_INDEX: u32 = 64;
global TD3_EXPIRY_DATE_INDEX: u32 = 65;

/// ICAO document codes: passports start with 'P'; TD1 ID cards with 'I'/'A'/'C'.
global ASCII_UPPER_P: u8 = 0x50;

pub struct DisclosedNationality {
    /// Raw alpha-3 bytes exactly as disclosed from the MRZ. NOT normalized:
    /// German documents carry "D<<", not "DEU" — normalize at display time, and
    /// keep any app-side claim-value packing raw so both sides stay in lockstep.
    pub nationality: [u8; 3],
    /// Big-endian pack of the 3 bytes (matches @zkpassport/utils' getCountryWeightedSum).
    packed: Field,
    is_id_card: bool,
}

/// Read the nationality out of a disclose payload, layout-aware (TD3 passports
/// vs TD1 ID cards put it at different MRZ offsets).
///
/// Soundness: the mask is PROVER-chosen (any mask yields a valid disclosure
/// commitment), so the layout must never be inferred from which ranges happen
/// to be unmasked — a passport holder could alias document-number bytes into
/// the TD1 nationality slot. The branch therefore reads the document code,
/// which is part of the signed MRZ — and so requires it disclosed. The ZKPassport
/// SDK discloses it alongside the nationality from 0.20.1; a request from an older
/// SDK must ask for `.disclose("document_type")`.
pub fn disclosed_nationality(mask: DiscloseMask, disclosed: MRZData) -> DisclosedNationality {
    let is_id_card = uses_id_card_layout(mask, disclosed);
    let start = if is_id_card {
        TD1_NATIONALITY_INDEX
    } else {
        TD3_NATIONALITY_INDEX
    };
    let nationality = disclosed_bytes(mask, disclosed, start, "nationality not disclosed");

    let mut packed: Field = 0;
    for i in 0..3 {
        packed = packed * 256 + (nationality[i] as Field);
    }
    DisclosedNationality { nationality, packed, is_id_card }
}

/// Read the document code, such as "P<" for a passport or "I<" for an ID card.
pub fn disclosed_document_type(mask: DiscloseMask, disclosed: MRZData) -> [u8; 2] {
    disclosed_bytes(
        mask,
        disclosed,
        MRZ_DOC_TYPE_INDEX,
        "document type not disclosed",
    )
}

/// Read the issuing country's three-letter code as the MRZ carries it ("D<<" for Germany).
pub fn disclosed_issuing_country(mask: DiscloseMask, disclosed: MRZData) -> [u8; 3] {
    disclosed_bytes(
        mask,
        disclosed,
        ISSUING_COUNTRY_INDEX,
        "issuing country not disclosed",
    )
}

/// Read the document number's nine MRZ characters, padded with '<'.
pub fn disclosed_document_number(mask: DiscloseMask, disclosed: MRZData) -> [u8; 9] {
    let start = if uses_id_card_layout(mask, disclosed) {
        TD1_DOCUMENT_NUMBER_INDEX
    } else {
        TD3_DOCUMENT_NUMBER_INDEX
    };
    disclosed_bytes(mask, disclosed, start, "document number not disclosed")
}

/// Read the date of birth as YYMMDD ASCII digits.
pub fn disclosed_birthdate(mask: DiscloseMask, disclosed: MRZData) -> [u8; 6] {
    let start = if uses_id_card_layout(mask, disclosed) {
        TD1_BIRTHDATE_INDEX
    } else {
        TD3_BIRTHDATE_INDEX
    };
    disclosed_bytes(mask, disclosed, start, "birthdate not disclosed")
}

/// Read the expiry date as YYMMDD ASCII digits.
pub fn disclosed_expiry_date(mask: DiscloseMask, disclosed: MRZData) -> [u8; 6] {
    let start = if uses_id_card_layout(mask, disclosed) {
        TD1_EXPIRY_DATE_INDEX
    } else {
        TD3_EXPIRY_DATE_INDEX
    };
    disclosed_bytes(mask, disclosed, start, "expiry date not disclosed")
}

/// Read the gender: 'M', 'F' or '<'.
pub fn disclosed_gender(mask: DiscloseMask, disclosed: MRZData) -> u8 {
    let start = if uses_id_card_layout(mask, disclosed) {
        TD1_GENDER_INDEX
    } else {
        TD3_GENDER_INDEX
    };
    let gender: [u8; 1] = disclosed_bytes(mask, disclosed, start, "gender not disclosed");
    gender[0]
}

/// Read the MRZ name field, such as "ERIKSSON<<ANNA<MARIA<<<", with 0 for each byte the proof
/// does not disclose. A request for the first or last name alone discloses only that part; a
/// proof that discloses none of the name fails.
pub fn disclosed_name(mask: DiscloseMask, disclosed: MRZData) -> BoundedVec<u8, TD3_NAME_LENGTH> {
    let mut name = BoundedVec::new();
    let mut any_byte_disclosed = false;
    if uses_id_card_layout(mask, disclosed) {
        for i in 0..TD1_NAME_LENGTH {
            name.push(disclosed[TD1_NAME_INDEX + i]);
            any_byte_disclosed |= mask[TD1_NAME_INDEX + i];
        }
    } else {
        for i in 0..TD3_NAME_LENGTH {
            name.push(disclosed[TD3_NAME_INDEX + i]);
            any_byte_disclosed |= mask[TD3_NAME_INDEX + i];
        }
    }

    assert(any_byte_disclosed, "name not disclosed");
    name
}

/// Read the MRZ name field, such as "ERIKSSON<<ANNA<MARIA<<<", which the proof must disclose whole.
pub fn disclosed_full_name(
    mask: DiscloseMask,
    disclosed: MRZData,
) -> BoundedVec<u8, TD3_NAME_LENGTH> {
    let mut name = BoundedVec::new();
    if uses_id_card_layout(mask, disclosed) {
        let field: [u8; TD1_NAME_LENGTH] =
            disclosed_bytes(mask, disclosed, TD1_NAME_INDEX, "full name not disclosed");
        for i in 0..TD1_NAME_LENGTH {
            name.push(field[i]);
        }
    } else {
        let field: [u8; TD3_NAME_LENGTH] =
            disclosed_bytes(mask, disclosed, TD3_NAME_INDEX, "full name not disclosed");
        for i in 0..TD3_NAME_LENGTH {
            name.push(field[i]);
        }
    }
    name
}

fn uses_id_card_layout(mask: DiscloseMask, disclosed: MRZData) -> bool {
    assert(mask[MRZ_DOC_TYPE_INDEX], "document type not disclosed");
    disclosed[MRZ_DOC_TYPE_INDEX] != ASCII_UPPER_P
}

fn disclosed_bytes<let N: u32, let M: u32>(
    mask: DiscloseMask,
    disclosed: MRZData,
    start: u32,
    message: str<M>,
) -> [u8; N] {
    let mut bytes = [0; N];
    for i in 0..N {
        assert(mask[start + i], message);
        bytes[i] = disclosed[start + i];
    }
    bytes
}
