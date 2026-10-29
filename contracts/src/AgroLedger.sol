// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAgroLedger} from "@agro-cpr/spec/IAgroLedger.sol";

/// @title AgroLedger
/// @notice Soulbound ERC-721 per CPR plus an append-only event log with a hash chain
/// per subject. Proves what the backend recorded and when, and that only one CPR exists
/// per (plot, season). It does not prove the recorded facts are true.
contract AgroLedger is IAgroLedger, ERC721, AccessControl, Pausable {
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    // Mirrors EVENT_TYPE_CODES in packages/spec/src/events.ts.
    uint16 public constant CPR_ISSUED = 3;
    uint16 public constant CPR_SETTLED = 16;
    uint16 public constant EVENT_CORRECTED = 17;
    uint16 public constant EVENT_VOIDED = 18;
    uint16 public constant MAX_EVENT_TYPE = 21; // 19-21: insurance events

    uint256 public constant MAX_BATCH = 50;
    // Tolerated clock skew between the backend and the chain.
    uint256 public constant MAX_FUTURE_SKEW = 1 hours;

    address public immutable custody;

    struct Head {
        uint64 seq;
        bytes32 head;
    }

    mapping(uint256 tokenId => Cpr) private _cprs;
    mapping(bytes32 subjectKey => Head) private _heads;
    mapping(bytes32 eventId => bytes32 subjectKey) private _subjectOf;

    error ZeroAddress();
    error AdminIsRelayer();

    constructor(address admin, address relayer, address custody_) ERC721("AgroLedger CPR", "CPR") {
        if (admin == address(0) || relayer == address(0) || custody_ == address(0)) revert ZeroAddress();
        // The admin (Safe) must be able to revoke a compromised relayer.
        if (admin == relayer) revert AdminIsRelayer();
        custody = custody_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RELAYER_ROLE, relayer);
    }

    // ---------- writes ----------

    function issueCpr(CprInput calldata cpr, EventInput calldata issuedEvent)
        external
        onlyRole(RELAYER_ROLE)
        whenNotPaused
        returns (uint256 tokenId)
    {
        if (
            cpr.plotKey == 0 || cpr.seasonKey == 0 || cpr.producerKey == 0 || cpr.warehouseKey == 0
                || cpr.issuedKg == 0 || cpr.dueDate == 0
        ) revert InvalidEventInput();
        if (cpr.issuedKg > cpr.eligibleKg) revert IssuedAboveEligible(cpr.issuedKg, cpr.eligibleKg);

        bytes32 cycleKey = cycleKeyFor(cpr.plotKey, cpr.seasonKey);
        tokenId = uint256(cycleKey);
        if (_cprs[tokenId].status != CprStatus.None) revert CprAlreadyExists(tokenId);

        if (issuedEvent.eventType != CPR_ISSUED) revert EventTypeMismatch(CPR_ISSUED, issuedEvent.eventType);
        if (issuedEvent.subjectKey != cycleKey) revert EventSubjectMismatch(cycleKey, issuedEvent.subjectKey);
        if (issuedEvent.unit != Unit.Kg || issuedEvent.quantity != cpr.issuedKg) revert InvalidEventInput();

        _cprs[tokenId] = Cpr({
            producerKey: cpr.producerKey,
            warehouseKey: cpr.warehouseKey,
            eligibleKg: cpr.eligibleKg,
            issuedKg: cpr.issuedKg,
            dueDate: cpr.dueDate,
            issuedAt: uint64(block.timestamp),
            settledAt: 0,
            status: CprStatus.Issued,
            issuedRecordHash: issuedEvent.recordHash
        });
        _record(issuedEvent);
        // _mint, not _safeMint: no receiver callback, so no reentrancy surface.
        _mint(custody, tokenId);

        emit CprIssued(tokenId, cpr.producerKey, cpr.warehouseKey, cpr.eligibleKg, cpr.issuedKg, cpr.dueDate);
    }

    function settleCpr(uint256 tokenId, EventInput calldata settledEvent)
        external
        onlyRole(RELAYER_ROLE)
        whenNotPaused
    {
        Cpr storage c = _cprs[tokenId];
        if (c.status != CprStatus.Issued) revert CprNotIssued(tokenId);
        if (settledEvent.eventType != CPR_SETTLED) revert EventTypeMismatch(CPR_SETTLED, settledEvent.eventType);
        if (settledEvent.subjectKey != bytes32(tokenId)) {
            revert EventSubjectMismatch(bytes32(tokenId), settledEvent.subjectKey);
        }

        c.status = CprStatus.Settled;
        c.settledAt = uint64(block.timestamp);
        _record(settledEvent);

        emit CprSettled(tokenId, c.settledAt);
    }

    function recordEvent(EventInput calldata e) external onlyRole(RELAYER_ROLE) whenNotPaused {
        _checkNotReserved(e.eventType);
        _record(e);
    }

    function recordEvents(EventInput[] calldata events) external onlyRole(RELAYER_ROLE) whenNotPaused {
        uint256 n = events.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH) revert BatchTooLarge(n, MAX_BATCH);
        for (uint256 i; i < n; ++i) {
            _checkNotReserved(events[i].eventType);
            _record(events[i]);
        }
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ---------- reads ----------

    function cycleKeyFor(bytes32 plotKey, bytes32 seasonKey) public pure returns (bytes32) {
        return keccak256(abi.encode(plotKey, seasonKey));
    }

    function cprOf(uint256 tokenId) external view returns (Cpr memory) {
        return _cprs[tokenId];
    }

    function headOf(bytes32 subjectKey) external view returns (uint64 seq, bytes32 head) {
        Head storage h = _heads[subjectKey];
        return (h.seq, h.head);
    }

    function isRecorded(bytes32 eventId) external view returns (bool) {
        return _subjectOf[eventId] != 0;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    // ---------- soulbound ----------

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    // ---------- internals ----------

    function _checkNotReserved(uint16 eventType) private pure {
        if (eventType == CPR_ISSUED || eventType == CPR_SETTLED) revert ReservedEventType(eventType);
    }

    function _record(EventInput calldata e) private {
        if (e.subjectKey == 0 || e.eventId == 0 || e.recordHash == 0 || e.occurredAt == 0) revert InvalidEventInput();
        if (e.eventType == 0 || e.eventType > MAX_EVENT_TYPE) revert InvalidEventInput();
        if (e.occurredAt > block.timestamp + MAX_FUTURE_SKEW) revert InvalidEventInput();
        if (e.unit == Unit.None && e.quantity != 0) revert InvalidEventInput();

        bool isRef = e.eventType == EVENT_CORRECTED || e.eventType == EVENT_VOIDED;
        if (isRef != (e.refEventId != 0)) revert InvalidEventInput();
        if (isRef) {
            // The corrected event must already be anchored, on the same subject.
            bytes32 refSubject = _subjectOf[e.refEventId];
            if (refSubject == 0) revert InvalidEventInput();
            if (refSubject != e.subjectKey) revert EventSubjectMismatch(refSubject, e.subjectKey);
        }

        if (_subjectOf[e.eventId] != 0) revert EventAlreadyRecorded(e.eventId);
        _subjectOf[e.eventId] = e.subjectKey;

        Head storage h = _heads[e.subjectKey];
        bytes32 newHead = keccak256(abi.encode(h.head, e.recordHash));
        uint64 seq = h.seq + 1;
        h.seq = seq;
        h.head = newHead;

        emit EventRecorded(
            e.subjectKey,
            e.eventId,
            e.eventType,
            seq,
            e.unit,
            e.quantity,
            e.occurredAt,
            e.evidenceHash,
            e.refEventId,
            e.recordHash,
            newHead
        );
    }
}
