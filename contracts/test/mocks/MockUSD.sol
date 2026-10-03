// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/*
 * ############################################################################
 * ##                                                                        ##
 * ##   TEST TOOLING ONLY                                                    ##
 * ##                                                                        ##
 * ##   This contract exists solely for local anvil integration testing     ##
 * ##   of the SPORE backend.                                                ##
 * ##                                                                        ##
 * ##   MUST NEVER be deployed to a real chain.                              ##
 * ##   MUST NEVER be used as the production settlement asset.               ##
 * ##                                                                        ##
 * ##   It has an admin-controlled, unlimited mint and no real value.        ##
 * ##                                                                        ##
 * ############################################################################
 */

/// @title MockUSD
/// @notice Mock ERC20 with admin-only minting. TEST USE ONLY.
contract MockUSD is ERC20 {
    /// @notice Thrown when a non-admin attempts to mint.
    error MockUSD_OnlyAdmin();

    /// @notice The deployer, the only address allowed to mint.
    address public immutable admin;

    modifier onlyAdmin() {
        if (msg.sender != admin) revert MockUSD_OnlyAdmin();
        _;
    }

    /// @param name_ Token name (suggested: "Mock USD").
    /// @param symbol_ Token symbol (suggested: "MUSD").
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        admin = msg.sender;
        _mint(msg.sender, 1_000_000 * 10 ** decimals());
    }

    /// @notice Mint `amount` tokens to `to`. Admin only.
    function mint(address to, uint256 amount) external onlyAdmin {
        _mint(to, amount);
    }

    /// @notice Mint `amount` tokens to each of `accounts`. Admin only.
    function mintToTestAccounts(address[] calldata accounts, uint256 amount) external onlyAdmin {
        uint256 len = accounts.length;
        for (uint256 i = 0; i < len; ++i) {
            _mint(accounts[i], amount);
        }
    }
}
