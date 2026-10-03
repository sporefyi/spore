// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import "./interfaces/ISpore.sol";

/// @title SporeRegistry
/// @notice Registry of agents participating in the SPORE credit protocol.
/// @dev Trust assumptions:
///      - Agent owner identity is controlled by msg.sender at registration; there is no
///        off-chain identity verification.
///      - OPERATOR_ROLE is trusted to activate/deactivate agents and to edit metadata.
///      - DEFAULT_ADMIN_ROLE is trusted to reassign agent owners and manage roles.
///      - This registry is NOT upgradeable.
contract SporeRegistry is AccessControl, ISporeRegistry {
    /// @notice Thrown when a metadata URI is empty.
    error Spore_EmptyMetadataURI();

    /// @notice Role allowed to (de)activate agents and edit any agent's metadata.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    uint256 private _nextId = 1;
    mapping(uint256 => AgentRecord) private _agents;

    /// @param admin Address granted DEFAULT_ADMIN_ROLE and OPERATOR_ROLE.
    constructor(address admin) {
        if (admin == address(0)) revert Spore_ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);
    }

    /// @notice Register a new agent owned by the caller.
    /// @param metadataURI Non-empty metadata URI for the agent.
    /// @return agentId The newly assigned agent id (starting at 1).
    function registerAgent(string calldata metadataURI) external override returns (uint256 agentId) {
        if (bytes(metadataURI).length == 0) revert Spore_EmptyMetadataURI();
        agentId = _nextId;
        _agents[agentId] = AgentRecord({
            owner: msg.sender,
            metadataURI: metadataURI,
            active: true,
            registeredAt: uint64(block.timestamp)
        });
        _nextId = agentId + 1;
        emit AgentRegistered(agentId, msg.sender, metadataURI);
    }

    /// @notice Update an agent's metadata URI.
    /// @dev Callable by the agent owner or an OPERATOR_ROLE holder.
    /// @param agentId The agent id.
    /// @param metadataURI New non-empty metadata URI.
    function setMetadataURI(uint256 agentId, string calldata metadataURI) external override {
        AgentRecord storage a = _requireExists(agentId);
        if (msg.sender != a.owner && !hasRole(OPERATOR_ROLE, msg.sender)) {
            revert Spore_NotAgentOwner(agentId, msg.sender);
        }
        if (bytes(metadataURI).length == 0) revert Spore_EmptyMetadataURI();
        a.metadataURI = metadataURI;
    }

    /// @notice Transfer agent ownership to a new address.
    /// @dev Callable by the current owner or a DEFAULT_ADMIN_ROLE holder.
    /// @param agentId The agent id.
    /// @param newOwner The new owner; must be non-zero.
    function setAgentOwner(uint256 agentId, address newOwner) external override {
        AgentRecord storage a = _requireExists(agentId);
        if (msg.sender != a.owner && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert Spore_NotAgentOwner(agentId, msg.sender);
        }
        if (newOwner == address(0)) revert Spore_ZeroAddress();
        a.owner = newOwner;
    }

    /// @notice Deactivate an agent. Only OPERATOR_ROLE.
    /// @param agentId The agent id.
    function deactivateAgent(uint256 agentId) external override {
        _checkRole(OPERATOR_ROLE);
        _requireExists(agentId).active = false;
    }

    /// @notice Reactivate an agent. Only OPERATOR_ROLE.
    /// @param agentId The agent id.
    function reactivateAgent(uint256 agentId) external override {
        _checkRole(OPERATOR_ROLE);
        _requireExists(agentId).active = true;
    }

    /// @notice Get the full record of an agent.
    /// @param agentId The agent id.
    /// @return The agent record; reverts if the id was never issued.
    function getAgent(uint256 agentId) external view override returns (AgentRecord memory) {
        return _requireExists(agentId);
    }

    /// @notice Total number of agents ever registered.
    /// @return The agent count.
    function agentCount() external view override returns (uint256) {
        return _nextId - 1;
    }

    /// @notice Whether an agent exists and is active.
    /// @param agentId The agent id.
    /// @return True if the agent exists and is active; false otherwise (never reverts).
    function isActiveAgent(uint256 agentId) external view override returns (bool) {
        AgentRecord storage a = _agents[agentId];
        return a.owner != address(0) && a.active;
    }

    /// @notice Owner of an agent.
    /// @param agentId The agent id.
    /// @return The owner address; reverts if the id was never issued.
    function agentOwner(uint256 agentId) external view override returns (address) {
        return _requireExists(agentId).owner;
    }

    function _requireExists(uint256 agentId) private view returns (AgentRecord storage a) {
        a = _agents[agentId];
        if (a.owner == address(0)) revert Spore_AgentNotFound(agentId);
    }
}
