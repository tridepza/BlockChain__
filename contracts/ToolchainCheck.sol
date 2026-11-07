// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Environment check only; this is not an escrow contract.
contract ToolchainCheck {
    uint256 public immutable value;

    constructor(uint256 initialValue) {
        value = initialValue;
    }
}
