// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title A wallet that cannot pay without Moat
/// @notice Holds testnet funds and executes a payment only when the owner
///         presents an EIP-712 signature from Moat's co-signing key over
///         that exact payment. See ADR 0010.
///
///         The owner is the agent. It keeps its own key and remains the only
///         party that can propose a payment. It cannot move anything alone,
///         because it cannot forge Moat's signature. Moat cannot move
///         anything either: it holds no funds and the contract accepts calls
///         only from the owner. This is the whole point -- Moat's verdict
///         stops being advice the agent may decline to take.
///
/// @dev Unaudited, testnet only, and deliberately without an escape hatch.
///      A timelock letting the owner act alone after a delay is what a real
///      deployment needs (a Moat that is down must not freeze funds
///      forever) and is exactly what would weaken the property being
///      demonstrated here, so it is left out and called out instead.
contract MoatGuardedWallet {
    /// @notice The agent. Only it may call `execute`.
    address public immutable owner;
    /// @notice Moat's co-signing address. Only its signatures are accepted.
    address public immutable moat;
    /// @notice Evidence ids already executed. One verdict, one payment.
    mapping(bytes32 => bool) public spent;

    bytes32 private constant VERDICT_TYPEHASH =
        keccak256(
            "MoatVerdict(address wallet,address to,address token,uint256 value,bytes32 evidenceId,uint256 expiry)"
        );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    /// @dev Half the curve order. A signature with a larger `s` is the same
    ///      signature in its other form; accepting both would let one
    ///      verdict be presented as two distinct byte strings.
    uint256 private constant HALF_N =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes32 private immutable domainSeparator;

    error NotOwner();
    error Expired();
    error AlreadySpent();
    error BadSignature();
    error TransferFailed();

    event Executed(
        address indexed to,
        address indexed token,
        uint256 value,
        bytes32 indexed evidenceId
    );

    /// @param moat_ Moat's co-signing address, from `moat_secp256k1.address`.
    constructor(address moat_) payable {
        require(moat_ != address(0), "moat address required");
        owner = msg.sender;
        moat = moat_;
        // Bound to this chain and this deployment, so a signature cannot be
        // replayed onto another network or another wallet.
        domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("Moat"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    receive() external payable {}

    /// @notice The digest Moat signs. Exposed so a caller can check a
    ///         signature before spending gas on a transaction that reverts.
    function digest(
        address to,
        address token,
        uint256 value,
        bytes32 evidenceId,
        uint256 expiry
    ) public view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    domainSeparator,
                    keccak256(
                        abi.encode(
                            VERDICT_TYPEHASH,
                            address(this),
                            to,
                            token,
                            value,
                            evidenceId,
                            expiry
                        )
                    )
                )
            );
    }

    /// @notice Pay `value` of `token` (or native value when `token` is zero)
    ///         to `to`, if and only if Moat signed exactly this.
    /// @param evidenceId The Moat evidence record that allowed it. Spent once.
    /// @param signature 65 bytes of r, s, v from Moat's co-signing key.
    function execute(
        address to,
        address token,
        uint256 value,
        bytes32 evidenceId,
        uint256 expiry,
        bytes calldata signature
    ) external {
        if (msg.sender != owner) revert NotOwner();
        if (block.timestamp > expiry) revert Expired();
        if (spent[evidenceId]) revert AlreadySpent();
        if (_recover(digest(to, token, value, evidenceId, expiry), signature) != moat) {
            revert BadSignature();
        }
        // Marked before the transfer: a recipient that calls back in finds
        // the id already spent.
        spent[evidenceId] = true;

        if (token == address(0)) {
            (bool sent, ) = to.call{value: value}("");
            if (!sent) revert TransferFailed();
        } else {
            // transfer(address,uint256), tolerating the tokens that return
            // nothing instead of a bool.
            (bool ok, bytes memory data) = token.call(
                abi.encodeWithSelector(0xa9059cbb, to, value)
            );
            if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
                revert TransferFailed();
            }
        }
        emit Executed(to, token, value, evidenceId);
    }

    function _recover(bytes32 hash, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (uint256(s) > HALF_N) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(hash, v, r, s);
    }
}
