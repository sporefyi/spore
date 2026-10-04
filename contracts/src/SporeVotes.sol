// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {ERC20Wrapper} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Wrapper.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title SporeVotes (vSPORE)
/// @notice ERC20Votes wrapper around $SPORE, the protocol's governance voting token.
/// @dev WHY THE WRAPPER EXISTS: $SPORE is a standard ERC20 with no voting
///      checkpoints. OpenZeppelin's Governor reads voting power exclusively via
///      the IVotes interface (`getPastVotes` / `getPastTotalSupply`), which
///      requires the token itself to maintain historical checkpoints. Since the
///      already-deployed $SPORE contract cannot be upgraded to ERC20Votes, this
///      wrapper bridges it: holders deposit $SPORE 1:1 to mint vSPORE, and burn
///      vSPORE 1:1 to redeem their $SPORE.
///
///      Trust properties:
///      - 1:1 backing by construction: every vSPORE minted requires an equal
///        $SPORE deposit held in custody by this contract (`depositFor` /
///        `withdrawTo` from ERC20Wrapper), and every vSPORE burned releases the
///        underlying. Total vSPORE can never exceed custodied $SPORE, and vice
///        versa the contract never owes more $SPORE than it holds.
///      - No owner, no admin roles, no fee hooks, no upgradeability. There is no
///        privileged function in this contract at all: `wrap`/`unwrap` are
///        permissionless and symmetric for every holder.
///      - Voting power follows ERC20Votes: delegation is per-holder
///        (`delegate` / `delegateBySig` via the explicit ERC20Permit base),
///        checkpoints are block-number based (ERC-6372
///        `mode=blocknumber`), matching the Governor's default clock mode.
///      - Redemptions are instant and unconditional: there is no lockup and no
///        exit fee, so governance participation never strands $SPORE.
///
///      Operational note: unwrap (burn vSPORE -> redeem $SPORE) zeroes the
///      holder's delegated voting power, so a holder who unwraps mid-proposal
///      forfeits votes already cast for that proposal's snapshot.
contract SporeVotes is ERC20, ERC20Permit, ERC20Votes, ERC20Wrapper {
    using SafeERC20 for IERC20;

    /// @notice Revert when attempting to wrap or unwrap a zero amount.
    error SporeVotes_ZeroAmount();

    /// @param spore_ Address of the deployed $SPORE ERC20 (the underlying).
    constructor(IERC20 spore_)
        ERC20("Spore Votes", "vSPORE")
        ERC20Permit("Spore Votes")
        ERC20Wrapper(spore_)
    {
        require(address(spore_) != address(0), "SporeVotes: zero underlying");
    }

    /// @notice Deposit `amount` $SPORE and mint `amount` vSPORE to the caller.
    /// @dev Convenience wrapper over {ERC20Wrapper-depositFor}. Requires a
    ///      prior `approve` on the $SPORE token.
    /// @param amount Amount of $SPORE to wrap (18 decimals).
    function wrap(uint256 amount) external {
        if (amount == 0) revert SporeVotes_ZeroAmount();
        depositFor(msg.sender, amount);
    }

    /// @notice Burn `amount` vSPORE and redeem `amount` $SPORE to the caller.
    /// @dev Convenience wrapper over {ERC20Wrapper-withdrawTo}.
    /// @param amount Amount of vSPORE to unwrap (18 decimals).
    function unwrap(uint256 amount) external {
        if (amount == 0) revert SporeVotes_ZeroAmount();
        withdrawTo(msg.sender, amount);
    }

    /// @dev Decimals follow the underlying $SPORE (18), via ERC20Wrapper.
    function decimals() public view override(ERC20, ERC20Wrapper) returns (uint8) {
        return super.decimals();
    }

    /// @dev Route balance updates through the ERC20Votes checkpoint engine.
    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Votes)
    {
        super._update(from, to, value);
    }

    /// @dev Required: both ERC20Permit and Nonces define `nonces`.
    function nonces(address owner)
        public
        view
        override(ERC20Permit, Nonces)
        returns (uint256)
    {
        return super.nonces(owner);
    }
}
