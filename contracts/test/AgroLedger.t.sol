// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAgroLedger} from "@agro-cpr/spec/IAgroLedger.sol";
import {AgroLedger} from "../src/AgroLedger.sol";

contract AgroLedgerTest is Test {
    // Event codes from packages/spec/src/events.ts
    uint16 constant PLANTING_RECORDED = 5;
    uint16 constant INPUT_APPLICATION_RECORDED = 6;
    uint16 constant HARVEST_PLANNED = 7;
    uint16 constant HARVEST_STARTED = 8;
    uint16 constant TRUCK_DISPATCHED = 9;
    uint16 constant TRUCK_ARRIVED = 10;
    uint16 constant GRAIN_RECEIVED = 11;
    uint16 constant CDA_ISSUED = 12;
    uint16 constant GRAIN_RELEASED = 13;
    uint16 constant SALE_RECORDED = 14;
    uint16 constant CPR_ISSUED = 3;
    uint16 constant CPR_SETTLED = 16;
    uint16 constant EVENT_CORRECTED = 17;
    uint16 constant EVENT_VOIDED = 18;
    uint16 constant POLICY_ISSUED = 19;
    uint16 constant CLAIM_FILED = 20;
    uint16 constant CLAIM_SETTLED = 21;

    AgroLedger ledger;
    address admin = makeAddr("adminSafe");
    address relayer = makeAddr("relayer");
    address custody = makeAddr("custody");
    address stranger = makeAddr("stranger");

    bytes32 plotKey = keccak256("plot:1");
    bytes32 seasonKey = keccak256("season:2026/27-SAFRA");
    bytes32 producerKey = keccak256("producer:1");
    bytes32 warehouseKey = keccak256("warehouse:1");

    uint256 nextId = 1;

    function setUp() public {
        vm.warp(1_767_225_600); // 2026-01-01
        ledger = new AgroLedger(admin, relayer, custody);
    }

    // ---------- helpers ----------

    function _cycleKey() internal view returns (bytes32) {
        return ledger.cycleKeyFor(plotKey, seasonKey);
    }

    function _ev(bytes32 subject, uint16 eventType, IAgroLedger.Unit unit, uint128 qty)
        internal
        returns (IAgroLedger.EventInput memory e)
    {
        uint256 id = nextId++;
        e = IAgroLedger.EventInput({
            subjectKey: subject,
            eventId: bytes32(id << 128),
            eventType: eventType,
            unit: unit,
            quantity: qty,
            occurredAt: uint64(block.timestamp - 1 days),
            evidenceHash: bytes32(0),
            refEventId: bytes32(0),
            recordHash: keccak256(abi.encode("record", id))
        });
    }

    function _cprInput(uint128 eligibleKg, uint128 issuedKg) internal view returns (IAgroLedger.CprInput memory) {
        return IAgroLedger.CprInput({
            plotKey: plotKey,
            seasonKey: seasonKey,
            producerKey: producerKey,
            warehouseKey: warehouseKey,
            eligibleKg: eligibleKg,
            issuedKg: issuedKg,
            dueDate: uint64(block.timestamp + 180 days)
        });
    }

    function _issue(uint128 issuedKg) internal returns (uint256 tokenId) {
        IAgroLedger.EventInput memory e = _ev(_cycleKey(), CPR_ISSUED, IAgroLedger.Unit.Kg, issuedKg);
        vm.prank(relayer);
        tokenId = ledger.issueCpr(_cprInput(4_800_000, issuedKg), e);
    }

    function _record(IAgroLedger.EventInput memory e) internal {
        vm.prank(relayer);
        ledger.recordEvent(e);
    }

    // ---------- CPR issuance ----------

    function test_IssueCpr_MintsToCustodyAndAnchorsEvent() public {
        IAgroLedger.EventInput memory e = _ev(_cycleKey(), CPR_ISSUED, IAgroLedger.Unit.Kg, 4_000_000);
        vm.prank(relayer);
        uint256 tokenId = ledger.issueCpr(_cprInput(4_800_000, 4_000_000), e);

        assertEq(tokenId, uint256(_cycleKey()));
        assertEq(ledger.ownerOf(tokenId), custody);

        IAgroLedger.Cpr memory c = ledger.cprOf(tokenId);
        assertEq(uint8(c.status), uint8(IAgroLedger.CprStatus.Issued));
        assertEq(c.issuedKg, 4_000_000);
        assertEq(c.eligibleKg, 4_800_000);
        assertEq(c.issuedRecordHash, e.recordHash);

        (uint64 seq, bytes32 head) = ledger.headOf(_cycleKey());
        assertEq(seq, 1);
        assertEq(head, keccak256(abi.encode(bytes32(0), e.recordHash)));
        assertTrue(ledger.isRecorded(e.eventId));
    }

    function test_RevertWhen_SecondCprOnSamePlotAndSeason_EvenForAnotherProducer() public {
        uint256 tokenId = _issue(4_000_000);

        producerKey = keccak256("producer:tenant");
        IAgroLedger.EventInput memory e = _ev(_cycleKey(), CPR_ISSUED, IAgroLedger.Unit.Kg, 1_000_000);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IAgroLedger.CprAlreadyExists.selector, tokenId));
        ledger.issueCpr(_cprInput(4_800_000, 1_000_000), e);
    }

    function test_SamePlotDifferentSeason_IsAllowed() public {
        _issue(4_000_000);
        seasonKey = keccak256("season:2026/27-SAFRINHA");
        uint256 second = _issue(2_000_000);
        assertEq(ledger.ownerOf(second), custody);
    }

    function test_RevertWhen_IssuedAboveEligible() public {
        IAgroLedger.EventInput memory e = _ev(_cycleKey(), CPR_ISSUED, IAgroLedger.Unit.Kg, 5_000_000);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(IAgroLedger.IssuedAboveEligible.selector, uint128(5_000_000), uint128(4_800_000))
        );
        ledger.issueCpr(_cprInput(4_800_000, 5_000_000), e);
    }

    function testFuzz_IssueCapIsEnforced(uint128 eligibleKg, uint128 issuedKg) public {
        vm.assume(issuedKg > 0);
        IAgroLedger.EventInput memory e = _ev(_cycleKey(), CPR_ISSUED, IAgroLedger.Unit.Kg, issuedKg);
        vm.prank(relayer);
        if (issuedKg > eligibleKg) {
            vm.expectRevert(abi.encodeWithSelector(IAgroLedger.IssuedAboveEligible.selector, issuedKg, eligibleKg));
        }
        ledger.issueCpr(_cprInput(eligibleKg, issuedKg), e);
    }

    function test_RevertWhen_IssueEventHasWrongTypeOrSubject() public {
        IAgroLedger.EventInput memory e = _ev(_cycleKey(), PLANTING_RECORDED, IAgroLedger.Unit.Kg, 4_000_000);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IAgroLedger.EventTypeMismatch.selector, CPR_ISSUED, PLANTING_RECORDED));
        ledger.issueCpr(_cprInput(4_800_000, 4_000_000), e);

        bytes32 wrong = keccak256("other");
        bytes32 cycle = _cycleKey(); // outside the prank: an external call would consume it
        e = _ev(wrong, CPR_ISSUED, IAgroLedger.Unit.Kg, 4_000_000);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IAgroLedger.EventSubjectMismatch.selector, cycle, wrong));
        ledger.issueCpr(_cprInput(4_800_000, 4_000_000), e);
    }

    function test_RevertWhen_IssueEventQuantityDiffersFromCpr() public {
        IAgroLedger.EventInput memory e = _ev(_cycleKey(), CPR_ISSUED, IAgroLedger.Unit.Kg, 3_999_999);
        vm.prank(relayer);
        vm.expectRevert(IAgroLedger.InvalidEventInput.selector);
        ledger.issueCpr(_cprInput(4_800_000, 4_000_000), e);
    }

    // ---------- settlement ----------

    function test_SettleCpr_OnlyOnce() public {
        uint256 tokenId = _issue(4_000_000);
        IAgroLedger.EventInput memory e = _ev(_cycleKey(), CPR_SETTLED, IAgroLedger.Unit.Kg, 3_950_000);
        vm.prank(relayer);
        ledger.settleCpr(tokenId, e);

        IAgroLedger.Cpr memory c = ledger.cprOf(tokenId);
        assertEq(uint8(c.status), uint8(IAgroLedger.CprStatus.Settled));
        assertEq(c.settledAt, block.timestamp);

        e = _ev(_cycleKey(), CPR_SETTLED, IAgroLedger.Unit.Kg, 3_950_000);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IAgroLedger.CprNotIssued.selector, tokenId));
        ledger.settleCpr(tokenId, e);
    }

    // ---------- event log ----------

    function test_FullLifecycle_BuildsHashChain() public {
        bytes32 cycle = _cycleKey();
        _record(_ev(cycle, INPUT_APPLICATION_RECORDED, IAgroLedger.Unit.Kg, 1_000)); // pre-planting burndown
        uint256 tokenId = _issue(4_000_000);

        uint16[10] memory types = [
            PLANTING_RECORDED,
            INPUT_APPLICATION_RECORDED,
            HARVEST_PLANNED,
            HARVEST_STARTED,
            TRUCK_DISPATCHED,
            TRUCK_ARRIVED,
            GRAIN_RECEIVED,
            CDA_ISSUED,
            GRAIN_RELEASED,
            SALE_RECORDED
        ];
        (, bytes32 expected) = ledger.headOf(cycle);
        for (uint256 i; i < types.length; ++i) {
            IAgroLedger.Unit unit = types[i] == HARVEST_STARTED || types[i] == TRUCK_ARRIVED
                ? IAgroLedger.Unit.None
                : IAgroLedger.Unit.Kg;
            uint128 qty = unit == IAgroLedger.Unit.None ? 0 : 30_000;
            IAgroLedger.EventInput memory e = _ev(cycle, types[i], unit, qty);
            _record(e);
            expected = keccak256(abi.encode(expected, e.recordHash));
        }

        IAgroLedger.EventInput memory settled = _ev(cycle, CPR_SETTLED, IAgroLedger.Unit.Kg, 3_950_000);
        vm.prank(relayer);
        ledger.settleCpr(tokenId, settled);
        expected = keccak256(abi.encode(expected, settled.recordHash));

        (uint64 seq, bytes32 head) = ledger.headOf(cycle);
        assertEq(seq, 13);
        assertEq(head, expected);
    }

    function test_HeadMatchesOffChainRecomputation() public {
        bytes32 cycle = _cycleKey();
        IAgroLedger.EventInput memory a = _ev(cycle, PLANTING_RECORDED, IAgroLedger.Unit.M2, 1_000_000);
        IAgroLedger.EventInput memory b = _ev(cycle, HARVEST_STARTED, IAgroLedger.Unit.None, 0);
        _record(a);
        _record(b);

        bytes32 expected = keccak256(abi.encode(keccak256(abi.encode(bytes32(0), a.recordHash)), b.recordHash));
        (uint64 seq, bytes32 head) = ledger.headOf(cycle);
        assertEq(seq, 2);
        assertEq(head, expected);
    }

    function test_RevertWhen_EventIdReused() public {
        IAgroLedger.EventInput memory e = _ev(_cycleKey(), PLANTING_RECORDED, IAgroLedger.Unit.M2, 1);
        _record(e);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IAgroLedger.EventAlreadyRecorded.selector, e.eventId));
        ledger.recordEvent(e);
    }

    function test_RevertWhen_ReservedTypeViaRecordEvent() public {
        IAgroLedger.EventInput memory e = _ev(_cycleKey(), CPR_ISSUED, IAgroLedger.Unit.Kg, 1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IAgroLedger.ReservedEventType.selector, CPR_ISSUED));
        ledger.recordEvent(e);
    }

    function test_RevertWhen_InvalidInputs() public {
        bytes32 cycle = _cycleKey();

        IAgroLedger.EventInput memory e = _ev(cycle, 0, IAgroLedger.Unit.None, 0);
        vm.prank(relayer);
        vm.expectRevert(IAgroLedger.InvalidEventInput.selector);
        ledger.recordEvent(e);

        e = _ev(cycle, 22, IAgroLedger.Unit.None, 0); // above MAX_EVENT_TYPE
        vm.prank(relayer);
        vm.expectRevert(IAgroLedger.InvalidEventInput.selector);
        ledger.recordEvent(e);

        e = _ev(cycle, HARVEST_STARTED, IAgroLedger.Unit.None, 5); // quantity without unit
        vm.prank(relayer);
        vm.expectRevert(IAgroLedger.InvalidEventInput.selector);
        ledger.recordEvent(e);

        e = _ev(cycle, HARVEST_STARTED, IAgroLedger.Unit.None, 0);
        e.occurredAt = uint64(block.timestamp + 2 hours); // in the future
        vm.prank(relayer);
        vm.expectRevert(IAgroLedger.InvalidEventInput.selector);
        ledger.recordEvent(e);

        e = _ev(cycle, HARVEST_STARTED, IAgroLedger.Unit.None, 0);
        e.recordHash = bytes32(0);
        vm.prank(relayer);
        vm.expectRevert(IAgroLedger.InvalidEventInput.selector);
        ledger.recordEvent(e);
    }

    // ---------- insurance (codes 19-21, appended after the first release) ----------

    function test_InsuranceEvents_AreRecordedOnTheCycleChain() public {
        bytes32 cycle = _cycleKey();
        _issue(1_000_000);
        _record(_ev(cycle, POLICY_ISSUED, IAgroLedger.Unit.BrlCents, 250_000_000));
        _record(_ev(cycle, CLAIM_FILED, IAgroLedger.Unit.Kg, 120_000));
        IAgroLedger.EventInput memory settled = _ev(cycle, CLAIM_SETTLED, IAgroLedger.Unit.BrlCents, 0); // denied
        _record(settled);
        (uint64 seq,) = ledger.headOf(cycle);
        assertEq(seq, 4);
        assertTrue(ledger.isRecorded(settled.eventId));
        assertEq(ledger.MAX_EVENT_TYPE(), CLAIM_SETTLED);
    }

    // ---------- corrections ----------

    function test_Correction_RequiresAnchoredRefOnSameSubject() public {
        bytes32 cycle = _cycleKey();
        IAgroLedger.EventInput memory original = _ev(cycle, PLANTING_RECORDED, IAgroLedger.Unit.M2, 1_000_000);

        // Ref not anchored yet.
        IAgroLedger.EventInput memory fix = _ev(cycle, EVENT_CORRECTED, IAgroLedger.Unit.None, 0);
        fix.refEventId = original.eventId;
        vm.prank(relayer);
        vm.expectRevert(IAgroLedger.InvalidEventInput.selector);
        ledger.recordEvent(fix);

        _record(original);
        _record(fix);
        assertTrue(ledger.isRecorded(fix.eventId));

        // Ref on another subject.
        bytes32 otherPlot = keccak256("plot:2");
        IAgroLedger.EventInput memory voidElsewhere = _ev(otherPlot, EVENT_VOIDED, IAgroLedger.Unit.None, 0);
        voidElsewhere.refEventId = original.eventId;
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IAgroLedger.EventSubjectMismatch.selector, cycle, otherPlot));
        ledger.recordEvent(voidElsewhere);
    }

    function test_RevertWhen_RefOnNonCorrectionOrMissingOnCorrection() public {
        bytes32 cycle = _cycleKey();
        IAgroLedger.EventInput memory e = _ev(cycle, PLANTING_RECORDED, IAgroLedger.Unit.M2, 1);
        e.refEventId = keccak256("x");
        vm.prank(relayer);
        vm.expectRevert(IAgroLedger.InvalidEventInput.selector);
        ledger.recordEvent(e);

        e = _ev(cycle, EVENT_VOIDED, IAgroLedger.Unit.None, 0); // no ref
        vm.prank(relayer);
        vm.expectRevert(IAgroLedger.InvalidEventInput.selector);
        ledger.recordEvent(e);
    }

    // ---------- batches ----------

    function test_Batch_IsAllOrNothing() public {
        bytes32 cycle = _cycleKey();
        IAgroLedger.EventInput[] memory batch = new IAgroLedger.EventInput[](2);
        batch[0] = _ev(cycle, PLANTING_RECORDED, IAgroLedger.Unit.M2, 1);
        batch[1] = _ev(cycle, HARVEST_STARTED, IAgroLedger.Unit.None, 7); // invalid

        vm.prank(relayer);
        vm.expectRevert(IAgroLedger.InvalidEventInput.selector);
        ledger.recordEvents(batch);
        assertFalse(ledger.isRecorded(batch[0].eventId));

        batch[1].quantity = 0;
        vm.prank(relayer);
        ledger.recordEvents(batch);
        (uint64 seq,) = ledger.headOf(cycle);
        assertEq(seq, 2);
    }

    function test_RevertWhen_BatchEmptyOrTooLarge() public {
        vm.prank(relayer);
        vm.expectRevert(IAgroLedger.EmptyBatch.selector);
        ledger.recordEvents(new IAgroLedger.EventInput[](0));

        uint256 max = ledger.MAX_BATCH();
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IAgroLedger.BatchTooLarge.selector, max + 1, max));
        ledger.recordEvents(new IAgroLedger.EventInput[](max + 1));
    }

    // ---------- access, pause, soulbound ----------

    function test_RevertWhen_CallerIsNotRelayer() public {
        IAgroLedger.EventInput memory e = _ev(_cycleKey(), PLANTING_RECORDED, IAgroLedger.Unit.M2, 1);
        bytes32 role = ledger.RELAYER_ROLE();

        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vm.prank(stranger);
        ledger.recordEvent(e);

        // The admin Safe cannot write events either.
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, role));
        vm.prank(admin);
        ledger.recordEvent(e);
    }

    function test_Pause_BlocksWritesAndOnlyAdminCanPause() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, relayer, ledger.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(relayer);
        ledger.pause();

        vm.prank(admin);
        ledger.pause();

        IAgroLedger.EventInput memory e = _ev(_cycleKey(), PLANTING_RECORDED, IAgroLedger.Unit.M2, 1);
        vm.prank(relayer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        ledger.recordEvent(e);

        vm.prank(admin);
        ledger.unpause();
        _record(e);
    }

    function test_AdminCanRevokeRelayer() public {
        bytes32 role = ledger.RELAYER_ROLE();
        vm.prank(admin);
        ledger.revokeRole(role, relayer);

        IAgroLedger.EventInput memory e = _ev(_cycleKey(), PLANTING_RECORDED, IAgroLedger.Unit.M2, 1);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, relayer, role));
        vm.prank(relayer);
        ledger.recordEvent(e);
    }

    function test_RevertWhen_TransferOrApprove() public {
        uint256 tokenId = _issue(4_000_000);

        vm.prank(custody);
        vm.expectRevert(IAgroLedger.Soulbound.selector);
        ledger.transferFrom(custody, stranger, tokenId);

        vm.prank(custody);
        vm.expectRevert(IAgroLedger.Soulbound.selector);
        ledger.approve(stranger, tokenId);

        vm.prank(custody);
        vm.expectRevert(IAgroLedger.Soulbound.selector);
        ledger.setApprovalForAll(stranger, true);
    }

    function test_RevertWhen_ConstructorMisconfigured() public {
        vm.expectRevert(AgroLedger.ZeroAddress.selector);
        new AgroLedger(address(0), relayer, custody);

        vm.expectRevert(AgroLedger.AdminIsRelayer.selector);
        new AgroLedger(admin, admin, custody);
    }
}
