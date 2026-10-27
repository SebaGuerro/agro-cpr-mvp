// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AgroLedger} from "../src/AgroLedger.sol";

/// forge script script/Deploy.s.sol --rpc-url base_sepolia --account deployer --broadcast --verify
/// The deployer only pays gas: it gets no role. Admin powers go to the Safe.
contract Deploy is Script {
    function run() external returns (AgroLedger ledger) {
        address adminSafe = vm.envAddress("ADMIN_SAFE_ADDRESS");
        address relayer = vm.envAddress("RELAYER_ADDRESS");
        address custody = vm.envOr("CUSTODY_ADDRESS", adminSafe);

        require(block.chainid == 84532, "Deploy: expected Base Sepolia (84532)");

        vm.startBroadcast();
        ledger = new AgroLedger(adminSafe, relayer, custody);
        vm.stopBroadcast();

        console2.log("AgroLedger:", address(ledger));
        console2.log("Admin (Safe):", adminSafe);
        console2.log("Relayer:", relayer);
        console2.log("Custody:", custody);
    }
}
