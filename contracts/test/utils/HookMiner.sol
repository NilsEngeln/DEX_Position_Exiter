// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title HookMiner
/// @notice Library for mining hook addresses with specific flag requirements
/// @dev Hooks in Uniswap V4 must have addresses with specific bits set based on
///      which hooks they implement. This library helps find valid addresses.
library HookMiner {
    /// @notice Find a salt that produces a hook address with the required flags
    /// @param deployer The address that will deploy the hook (CREATE2 factory)
    /// @param flags The required hook flags (specific bits that must be set)
    /// @param creationCode The contract creation bytecode
    /// @param constructorArgs The ABI-encoded constructor arguments
    /// @return hookAddress The address the hook will be deployed to
    /// @return salt The salt to use for CREATE2 deployment
    function find(
        address deployer,
        uint160 flags,
        bytes memory creationCode,
        bytes memory constructorArgs
    ) internal pure returns (address hookAddress, bytes32 salt) {
        bytes memory bytecode = abi.encodePacked(creationCode, constructorArgs);
        bytes32 bytecodeHash = keccak256(bytecode);

        // Try different salts until we find one that produces a valid address
        for (uint256 i = 0; i < 10000; i++) {
            salt = bytes32(i);
            hookAddress = computeAddress(deployer, salt, bytecodeHash);

            // Check if the address has the required flags set
            if (hasRequiredFlags(hookAddress, flags)) {
                return (hookAddress, salt);
            }
        }

        revert("HookMiner: could not find valid salt");
    }

    /// @notice Compute the CREATE2 address for a contract
    /// @param deployer The deploying address
    /// @param salt The salt value
    /// @param bytecodeHash The keccak256 hash of the creation bytecode
    /// @return The computed address
    function computeAddress(
        address deployer,
        bytes32 salt,
        bytes32 bytecodeHash
    ) internal pure returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            deployer,
                            salt,
                            bytecodeHash
                        )
                    )
                )
            )
        );
    }

    /// @notice Check if an address has the required hook flags
    /// @param addr The address to check
    /// @param flags The required flags
    /// @return True if the address has all required flags set
    function hasRequiredFlags(address addr, uint160 flags) internal pure returns (bool) {
        // The last 14 bits of the address determine which hooks are enabled
        // We need to check that the required flag bits are set
        uint160 addressFlags = uint160(addr) & uint160(0x3FFF); // Last 14 bits
        return (addressFlags & flags) == flags;
    }
}
