# solana-orderbook

Fully on-chain limit orderbook with price-time priority matching. Place, cancel, and match orders without off-chain components.

![Rust](https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white)
![Solana](https://img.shields.io/badge/Solana-9945FF?logo=solana&logoColor=white)
![Anchor](https://img.shields.io/badge/Anchor-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

## Features

- Price-time priority matching
- Bid and ask sides
- Partial fills
- On-chain settlement

## Program Instructions

`initialize` | `place_order` | `cancel_order` | `match_orders`

## Build

```bash
anchor build
```

## Test

```bash
anchor test
```

## Deploy

```bash
# Devnet
anchor deploy --provider.cluster devnet

# Mainnet
anchor deploy --provider.cluster mainnet
```

## Project Structure

```
programs/
  solana-orderbook/
    src/
      lib.rs          # Program entry point and instructions
    Cargo.toml
tests/
  solana-orderbook.ts           # Integration tests
Anchor.toml             # Anchor configuration
```

## License

MIT — see [LICENSE](LICENSE) for details.

## Author

Built by [Purple Squirrel Media](https://purplesquirrelmedia.io)
