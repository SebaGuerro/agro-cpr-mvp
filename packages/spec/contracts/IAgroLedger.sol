// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title IAgroLedger
/// @notice Interface frozen by Prompt 0; implemented in Prompt 1.
/// One contract: a soulbound ERC-721 per CPR plus an append-only event log with a
/// hash chain per subject. Business rules, authorization and the state machine live
/// in the backend. Only RELAYER_ROLE writes; DEFAULT_ADMIN_ROLE grants roles and pauses.
/// Tokens are minted to a platform custody address; on-chain ownership has no legal
/// meaning in the pilot.
interface IAgroLedger {
    enum Unit {
        None,
        Kg,
        M2,
        Ml,
        BrlCents
    }

    enum CprStatus {
        None,
        Issued,
        Settled
    }

    struct EventInput {
        bytes32 subjectKey; // plotKey for PLOT events, cycleKey for CROP_CYCLE events
        bytes32 eventId; // event UUID, 16 bytes left-aligned
        uint16 eventType; // EVENT_TYPE_CODES in packages/spec
        Unit unit;
        uint128 quantity;
        uint64 occurredAt; // unix seconds, supplied by the backend, may be backdated
        bytes32 evidenceHash; // 0x0 when none
        bytes32 refEventId; // 0x0 unless EVENT_CORRECTED / EVENT_VOIDED
        bytes32 recordHash; // SHA-256 of the canonical stored event
    }

    struct CprInput {
        bytes32 plotKey;
        bytes32 seasonKey;
        bytes32 producerKey;
        bytes32 warehouseKey;
        uint128 eligibleKg;
        uint128 issuedKg;
        uint64 dueDate; // unix seconds, 00:00 America/Sao_Paulo on the due date
    }

    struct Cpr {
        bytes32 producerKey;
        bytes32 warehouseKey;
        uint128 eligibleKg;
        uint128 issuedKg;
        uint64 dueDate;
        uint64 issuedAt;
        uint64 settledAt;
        CprStatus status;
        bytes32 issuedRecordHash; // recordHash of the CPR_ISSUED event
    }

    /// @dev head = keccak256(abi.encode(previousHead, recordHash)); previousHead is 0x0 for seq 1.
    event EventRecorded(
        bytes32 indexed subjectKey,
        bytes32 indexed eventId,
        uint16 indexed eventType,
        uint64 seq,
        Unit unit,
        uint128 quantity,
        uint64 occurredAt,
        bytes32 evidenceHash,
        bytes32 refEventId,
        bytes32 recordHash,
        bytes32 head
    );

    event CprIssued(
        uint256 indexed tokenId,
        bytes32 indexed producerKey,
        bytes32 indexed warehouseKey,
        uint128 eligibleKg,
        uint128 issuedKg,
        uint64 dueDate
    );

    event CprSettled(uint256 indexed tokenId, uint64 settledAt);

    error EventAlreadyRecorded(bytes32 eventId);
    error EmptyBatch();
    error BatchTooLarge(uint256 size, uint256 max);
    error InvalidEventInput();
    error ReservedEventType(uint16 eventType); // CPR_ISSUED / CPR_SETTLED via issueCpr / settleCpr only
    error EventTypeMismatch(uint16 expected, uint16 actual);
    error EventSubjectMismatch(bytes32 expected, bytes32 actual);
    error CprAlreadyExists(uint256 tokenId);
    error IssuedAboveEligible(uint128 issuedKg, uint128 eligibleKg);
    error CprNotIssued(uint256 tokenId);
    error Soulbound();

    /// @return keccak256(abi.encode(plotKey, seasonKey)); tokenId = uint256(cycleKey).
    function cycleKeyFor(bytes32 plotKey, bytes32 seasonKey) external pure returns (bytes32);

    /// @notice Mints the CPR and appends its CPR_ISSUED event atomically.
    /// Reverts on a second CPR for the same (plot, season) or issuedKg > eligibleKg.
    function issueCpr(CprInput calldata cpr, EventInput calldata issuedEvent) external returns (uint256 tokenId);

    /// @notice Marks the CPR settled and appends its CPR_SETTLED event atomically.
    function settleCpr(uint256 tokenId, EventInput calldata settledEvent) external;

    function recordEvent(EventInput calldata e) external;

    /// @notice All-or-nothing; the implementation sets the max batch size.
    function recordEvents(EventInput[] calldata events) external;

    function cprOf(uint256 tokenId) external view returns (Cpr memory);

    function headOf(bytes32 subjectKey) external view returns (uint64 seq, bytes32 head);

    function isRecorded(bytes32 eventId) external view returns (bool);

    function pause() external;

    function unpause() external;
}
