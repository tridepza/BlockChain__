// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice A wallet can deposit and withdraw only its own FESC. There is no admin withdrawal.
contract FescVault is ReentrancyGuard {
    using SafeERC20 for IERC20;
    IERC20 public immutable token;
    mapping(address => uint256) public balances;
    uint256 public totalDeposited;
    event Deposited(address indexed wallet, uint256 amount);
    event Withdrawn(address indexed wallet, uint256 amount);
    error InvalidAmount();
    error InsufficientBalance();

    constructor(IERC20 fesc) { require(address(fesc).code.length > 0, "Invalid token"); token = fesc; }

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        require(token.balanceOf(address(this)) - beforeBalance == amount, "Unsupported token fee");
        balances[msg.sender] += amount;
        totalDeposited += amount;
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (balances[msg.sender] < amount) revert InsufficientBalance();
        balances[msg.sender] -= amount;
        totalDeposited -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }
}
