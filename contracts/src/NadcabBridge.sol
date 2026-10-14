// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BridgedToken} from "./BridgedToken.sol";

/**
 * @notice One bridge endpoint per chain. Deposits emit an event; the relayer of this deployment calls `release`
 * on the destination endpoint once the deposit has enough confirmations.
 *
 * Modes:
 *  - LOCK_MINT: the native coin is locked here. Coins from other chains arrive as BridgedToken ("wrapped"),
 *    one per origin chain, created on first use. Sending a wrapped token back burns it; its origin chain
 *    releases the locked coin.
 *  - BURN_MINT: one BridgedToken lives on every chain. Deposits burn it, releases mint it.
 *  - POOL: the native coin moves between chains whose pools the owner keeps funded.
 */
contract NadcabBridge {
    uint8 public constant MODE_LOCK_MINT = 0;
    uint8 public constant MODE_BURN_MINT = 1;
    uint8 public constant MODE_POOL = 2;
    uint16 public constant MAX_FEE_BPS = 1000;

    uint8 public immutable mode;
    /// @notice Canonical token for BURN_MINT, zero otherwise.
    address public immutable token;

    address public owner;
    address public relayer;
    uint16 public feeBps;
    bool public paused;
    uint64 public nonce;

    /// @notice Native coin backing wrapped tokens on other chains (LOCK_MINT).
    uint256 public lockedNative;
    /// @notice Fees collected in the native coin, withdrawable by the owner.
    uint256 public feesNative;

    mapping(uint256 => bool) public routeOut;
    mapping(bytes32 => bool) public processed;
    /// @notice origin chain id => wrapped token on this chain (LOCK_MINT).
    mapping(uint256 => address) public wrapped;
    /// @notice wrapped token => origin chain id (LOCK_MINT).
    mapping(address => uint256) public originOf;

    uint256 private entered = 1;

    event Deposit(
        bytes32 indexed id,
        uint256 indexed dstChainId,
        address indexed sender,
        address recipient,
        uint256 originChainId,
        uint256 amount,
        uint256 fee,
        uint64 nonce
    );
    event Release(bytes32 indexed id, uint256 indexed srcChainId, address indexed recipient, uint256 originChainId, uint256 amount);
    event WrappedCreated(uint256 indexed originChainId, address token);
    event RouteSet(uint256 indexed dstChainId, bool enabled);
    event RelayerSet(address relayer);
    event FeeSet(uint16 feeBps);
    event PausedSet(bool paused);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error OnlyOwner();
    error OnlyRelayer();
    error Paused();
    error BadMode();
    error BadRoute();
    error BadAmount();
    error ZeroAddress();
    error FeeTooHigh();
    error AlreadyProcessed();
    error NotWrapped();
    error InsufficientLiquidity();
    error TransferFailed();
    error Reentrant();

    constructor(
        uint8 _mode,
        address _relayer,
        uint16 _feeBps,
        uint256[] memory destinations,
        string memory tokenName,
        string memory tokenSymbol,
        uint256 initialSupply
    ) {
        if (_mode > MODE_POOL) revert BadMode();
        if (_relayer == address(0)) revert ZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        mode = _mode;
        owner = msg.sender;
        relayer = _relayer;
        feeBps = _feeBps;
        for (uint256 i = 0; i < destinations.length; i++) {
            if (destinations[i] == block.chainid || destinations[i] == 0) revert BadRoute();
            routeOut[destinations[i]] = true;
            emit RouteSet(destinations[i], true);
        }
        address canonical;
        if (_mode == MODE_BURN_MINT) {
            BridgedToken created = new BridgedToken(tokenName, tokenSymbol);
            canonical = address(created);
            if (initialSupply > 0) created.mint(msg.sender, initialSupply);
        }
        token = canonical;
        emit OwnershipTransferred(address(0), msg.sender);
        emit RelayerSet(_relayer);
        emit FeeSet(_feeBps);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier whenActive() {
        if (paused) revert Paused();
        _;
    }

    modifier nonReentrant() {
        if (entered != 1) revert Reentrant();
        entered = 2;
        _;
        entered = 1;
    }

    /* ---------- deposits ---------- */

    /// @notice Sends this chain's native coin to `recipient` on `dstChainId` (LOCK_MINT and POOL).
    function bridgeNative(uint256 dstChainId, address recipient) external payable whenActive nonReentrant returns (bytes32 id) {
        if (mode == MODE_BURN_MINT) revert BadMode();
        (uint256 net, uint256 fee) = _split(msg.value);
        feesNative += fee;
        if (mode == MODE_LOCK_MINT) lockedNative += net;
        id = _deposit(dstChainId, recipient, block.chainid, net, fee);
    }

    /// @notice Sends a bridge token: a wrapped coin (LOCK_MINT) or the canonical token (BURN_MINT).
    /// Approve this contract for `amount` first; the fee part is kept here and the rest is burned.
    function bridgeToken(address tokenAddress, uint256 dstChainId, address recipient, uint256 amount)
        external
        whenActive
        nonReentrant
        returns (bytes32 id)
    {
        uint256 origin;
        if (mode == MODE_BURN_MINT) {
            if (tokenAddress != token) revert NotWrapped();
        } else if (mode == MODE_LOCK_MINT) {
            origin = originOf[tokenAddress];
            if (origin == 0) revert NotWrapped();
        } else {
            revert BadMode();
        }
        (uint256 net, uint256 fee) = _split(amount);
        BridgedToken(tokenAddress).burnFrom(msg.sender, net);
        if (fee > 0 && !BridgedToken(tokenAddress).transferFrom(msg.sender, address(this), fee)) revert TransferFailed();
        id = _deposit(dstChainId, recipient, origin, net, fee);
    }

    function _split(uint256 amount) private view returns (uint256 net, uint256 fee) {
        if (amount == 0) revert BadAmount();
        fee = (amount * feeBps) / 10_000;
        net = amount - fee;
        if (net == 0) revert BadAmount();
    }

    function _deposit(uint256 dstChainId, address recipient, uint256 origin, uint256 net, uint256 fee) private returns (bytes32 id) {
        if (!routeOut[dstChainId]) revert BadRoute();
        if (recipient == address(0)) revert ZeroAddress();
        uint64 current = ++nonce;
        id = keccak256(abi.encode(block.chainid, address(this), current));
        emit Deposit(id, dstChainId, msg.sender, recipient, origin, net, fee, current);
    }

    /* ---------- releases (relayer) ---------- */

    /**
     * @param originChainId chain whose native coin this is (LOCK_MINT); ignored by the other modes.
     * @param wrappedName / wrappedSymbol name the wrapped token the first time an origin arrives here.
     */
    function release(
        bytes32 id,
        uint256 srcChainId,
        address recipient,
        uint256 originChainId,
        uint256 amount,
        string calldata wrappedName,
        string calldata wrappedSymbol
    ) external whenActive nonReentrant {
        if (msg.sender != relayer) revert OnlyRelayer();
        if (processed[id]) revert AlreadyProcessed();
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert BadAmount();
        processed[id] = true;

        if (mode == MODE_BURN_MINT) {
            BridgedToken(token).mint(recipient, amount);
        } else if (mode == MODE_POOL) {
            if (amount > poolLiquidity()) revert InsufficientLiquidity();
            _sendNative(recipient, amount);
        } else if (originChainId == block.chainid) {
            if (amount > lockedNative) revert InsufficientLiquidity();
            lockedNative -= amount;
            _sendNative(recipient, amount);
        } else {
            if (originChainId == 0) revert BadRoute();
            address wrappedToken = wrapped[originChainId];
            if (wrappedToken == address(0)) {
                wrappedToken = address(new BridgedToken(wrappedName, wrappedSymbol));
                wrapped[originChainId] = wrappedToken;
                originOf[wrappedToken] = originChainId;
                emit WrappedCreated(originChainId, wrappedToken);
            }
            BridgedToken(wrappedToken).mint(recipient, amount);
        }
        emit Release(id, srcChainId, recipient, originChainId, amount);
    }

    function _sendNative(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /* ---------- pool liquidity ---------- */

    function poolLiquidity() public view returns (uint256) {
        if (mode != MODE_POOL) return 0;
        return address(this).balance - feesNative;
    }

    /// @notice Anyone can fund the pool; only the owner can take liquidity out.
    function addLiquidity() external payable {
        if (mode != MODE_POOL) revert BadMode();
        if (msg.value == 0) revert BadAmount();
    }

    function removeLiquidity(address to, uint256 amount) external onlyOwner nonReentrant {
        if (mode != MODE_POOL) revert BadMode();
        if (amount > poolLiquidity()) revert InsufficientLiquidity();
        _sendNative(to, amount);
    }

    /* ---------- owner ---------- */

    function withdrawFees(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = feesNative;
        feesNative = 0;
        if (amount > 0) _sendNative(to, amount);
    }

    function withdrawTokenFees(address tokenAddress, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = BridgedToken(tokenAddress).balanceOf(address(this));
        if (amount > 0 && !BridgedToken(tokenAddress).transfer(to, amount)) revert TransferFailed();
    }

    function setRoute(uint256 dstChainId, bool enabled) external onlyOwner {
        if (dstChainId == block.chainid || dstChainId == 0) revert BadRoute();
        routeOut[dstChainId] = enabled;
        emit RouteSet(dstChainId, enabled);
    }

    function setRelayer(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        relayer = next;
        emit RelayerSet(next);
    }

    function setFee(uint16 next) external onlyOwner {
        if (next > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = next;
        emit FeeSet(next);
    }

    function setPaused(bool next) external onlyOwner {
        paused = next;
        emit PausedSet(next);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, next);
        owner = next;
    }

    receive() external payable {
        if (mode != MODE_POOL) revert BadMode();
    }
}
