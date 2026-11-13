// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract FreelanceToken is ERC20 {
    uint256 public constant INITIAL_BALANCE = 1_000 * 1e18;

    constructor(address[] memory recipients) ERC20("Freelance Token", "FESC") {
        for (uint256 i; i < recipients.length; ++i) {
            _mint(recipients[i], INITIAL_BALANCE);
        }
    }
}
