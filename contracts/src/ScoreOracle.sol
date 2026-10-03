// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./interfaces/ISpore.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ScoreOracle
/// @notice Publishes and timestamps agent credit scores for the SPORE credit protocol.
/// @dev TRUST MODEL — read before integrating:
///      - Scores are COMPUTED OFF-CHAIN (see docs/scoring.md, model v0.1). The model is
///        provisional and unvalidated.
///      - This contract only PUBLISHES and TIMESTAMPS values handed to it. It does NOT validate
///        score correctness, and the only on-chain check is the range check `score <= 1000`.
///      - Any holder of ORACLE_UPDATER_ROLE can publish ARBITRARY scores and limits for any
///        non-zero agentId. That role is fully trusted.
///      - Consumers (e.g. CreditManager) MUST check freshness via `isFresh()` / `maxStalePeriod`
///        before relying on a score. `getScore()` returns stored data regardless of age.
///      - No external calls, no value handling, not upgradeable.
contract ScoreOracle is IScoreOracle, AccessControl {
    /// @notice Role allowed to publish scores (fully trusted; can publish arbitrary values).
    bytes32 public constant ORACLE_UPDATER_ROLE = keccak256("ORACLE_UPDATER_ROLE");

    /// @notice Maximum age (seconds) of a score for it to be considered fresh by `isFresh()`.
    uint64 public override maxStalePeriod;

    /// @dev Latest published score per agent. `updatedAt != 0` is the "has score" sentinel;
    ///      publishScore always writes a non-zero block.timestamp, so this stays correct
    ///      for an agent that was published once and never again.
    mapping(uint256 agentId => ScoreData) private _scores;

    /// @notice Emitted when a score is published.
    /// @param agentId The agent the score applies to.
    /// @param score Off-chain computed score (0..1000).
    /// @param limit Off-chain computed credit limit.
    /// @param modelVersion Version of the off-chain scoring model that produced the score.
    event ScoreUpdated(uint256 indexed agentId, uint16 score, uint256 limit, uint8 modelVersion);

    /// @notice Deploys the oracle.
    /// @param admin_ Address granted DEFAULT_ADMIN_ROLE.
    /// @param updater_ Address granted ORACLE_UPDATER_ROLE.
    /// @param maxStalePeriod_ Initial freshness window in seconds.
    constructor(address admin_, address updater_, uint64 maxStalePeriod_) {
        if (admin_ == address(0) || updater_ == address(0)) revert Spore_ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ORACLE_UPDATER_ROLE, updater_);
        maxStalePeriod = maxStalePeriod_;
    }

    /// @notice Publishes a score for an agent, timestamped with the current block time.
    /// @dev Only checks agentId != 0 and score <= 1000. Does not validate correctness of the
    ///      score, limit, or modelVersion; those are trusted off-chain outputs.
    /// @param agentId Agent identifier (must be non-zero).
    /// @param score Score in range 0..1000.
    /// @param limit Credit limit computed off-chain.
    /// @param modelVersion Off-chain model version identifier.
    function publishScore(uint256 agentId, uint16 score, uint256 limit, uint8 modelVersion)
        external
        override
        onlyRole(ORACLE_UPDATER_ROLE)
    {
        if (agentId == 0) revert Spore_AgentNotFound(agentId);
        if (score > 1000) revert Spore_InvalidScore(score);

        _scores[agentId] = ScoreData(score, limit, uint64(block.timestamp), modelVersion);

        emit ScoreUpdated(agentId, score, limit, modelVersion);
    }

    /// @notice Returns the latest published score data for an agent, regardless of age.
    /// @dev Reverts with Spore_NoOracleData if nothing was ever published. Callers must check
    ///      `isFresh()` themselves; this function does not enforce freshness.
    /// @param agentId Agent identifier.
    /// @return The stored ScoreData.
    function getScore(uint256 agentId) external view override returns (ScoreData memory) {
        ScoreData memory data = _scores[agentId];
        if (data.updatedAt == 0) revert Spore_NoOracleData(agentId);
        return data;
    }

    /// @notice Whether a score has ever been published for the agent.
    /// @dev Uses `updatedAt != 0` as sentinel (publishScore always stores a non-zero timestamp).
    /// @param agentId Agent identifier.
    /// @return True iff a score was published at least once.
    function hasScore(uint256 agentId) external view override returns (bool) {
        return _scores[agentId].updatedAt != 0;
    }

    /// @notice Whether the agent's score exists and is no older than `maxStalePeriod`.
    /// @dev Defensive: if updatedAt were ever in the future (not possible in practice), this
    ///      returns false rather than underflowing. block.timestamp is inherent to the
    ///      freshness function — there is no other way to measure score age — and a few
    ///      seconds of validator leeway has no security impact here.
    /// @param agentId Agent identifier.
    /// @return True iff a score exists and `block.timestamp - updatedAt <= maxStalePeriod`.
    function isFresh(uint256 agentId) external view override returns (bool) {
        uint64 updatedAt = _scores[agentId].updatedAt;
        if (updatedAt == 0) return false;
        // Freshness is measured in wall-clock age; block.timestamp is the only clock available.
        // forge-lint: disable-next-line(block-timestamp)
        if (updatedAt > block.timestamp) return false;
        // forge-lint: disable-next-line(block-timestamp)
        return block.timestamp - updatedAt <= maxStalePeriod;
    }

    /// @notice Sets the freshness window used by `isFresh()`.
    /// @param maxStalePeriod_ New maximum score age in seconds.
    function setMaxStalePeriod(uint64 maxStalePeriod_) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        maxStalePeriod = maxStalePeriod_;
    }
}
