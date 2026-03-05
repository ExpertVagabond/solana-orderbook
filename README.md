# solana-orderbook

On-chain limit orderbook with bid/ask matching and partial fills on Solana.

![Rust](https://img.shields.io/badge/Rust-000000?logo=rust) ![Solana](https://img.shields.io/badge/Solana-9945FF?logo=solana&logoColor=white) ![Anchor](https://img.shields.io/badge/Anchor-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

## Overview

A Solana Anchor program implementing an on-chain limit orderbook for SPL token pairs. A market authority creates a base/quote trading pair. Makers place limit orders (bid or ask) by depositing collateral into the market vault. Takers fill orders partially or fully by providing the counterparty tokens. Unfilled orders can be cancelled with automatic refund of remaining collateral. Each order is stored as a PDA with fill tracking for partial execution.

## Program Instructions

| Instruction | Description | Key Accounts |
|---|---|---|
| `initialize_market` | Create a new trading pair with base and quote mints | `authority` (signer), `base_mint`, `quote_mint`, `market` (PDA) |
| `place_order` | Place a limit order (bid deposits quote tokens, ask deposits base tokens) | `owner` (signer), `market`, `order` (PDA), `user_token_account`, `vault` |
| `fill_order` | Fill an existing order partially or fully | `taker` (signer), `market`, `order`, `vault`, `taker_base`, `taker_quote`, `maker_base`, `maker_quote` |
| `cancel_order` | Cancel an open order and refund remaining collateral | `owner` (signer), `market`, `order`, `vault`, `owner_token_account` |

## Account Structures

### Market

| Field | Type | Description |
|---|---|---|
| `authority` | `Pubkey` | Market creator |
| `base_mint` | `Pubkey` | Base token mint |
| `quote_mint` | `Pubkey` | Quote token mint |
| `order_count` | `u64` | Incrementing order ID counter |
| `bump` | `u8` | PDA bump seed |

### Order

| Field | Type | Description |
|---|---|---|
| `market` | `Pubkey` | Associated market |
| `owner` | `Pubkey` | Order creator |
| `id` | `u64` | Order index |
| `side` | `Side` | `Bid` or `Ask` |
| `price` | `u64` | Limit price (quote per base) |
| `quantity` | `u64` | Total order quantity in base tokens |
| `filled` | `u64` | Amount already filled |
| `timestamp` | `i64` | Order creation timestamp |
| `bump` | `u8` | PDA bump seed |

### Side (Enum)

| Variant | Description |
|---|---|
| `Bid` | Buy order: deposits quote tokens, receives base tokens |
| `Ask` | Sell order: deposits base tokens, receives quote tokens |

## PDA Seeds

- **Market:** `["market", authority, base_mint, quote_mint]`
- **Order:** `["order", market, order_count_bytes]`

## Order Mechanics

- **Bid placement:** Deposits `price * quantity` quote tokens into the vault
- **Ask placement:** Deposits `quantity` base tokens into the vault
- **Fill (bid):** Taker sends base tokens to maker, vault releases quote tokens to taker
- **Fill (ask):** Taker sends quote tokens to maker, vault releases base tokens to taker
- **Cancel:** Refunds remaining unfilled collateral from vault to owner

## Error Codes

| Error | Description |
|---|---|
| `InvalidOrder` | Price and quantity must be greater than zero |
| `InvalidFill` | Fill quantity must be between 1 and remaining |
| `AlreadyFilled` | Order is fully filled and cannot be cancelled |
| `Overflow` | Arithmetic overflow |

## Build & Test

```bash
anchor build
anchor test
```

## Deploy

```bash
solana config set --url devnet
anchor deploy
```

## License

[MIT](LICENSE)
