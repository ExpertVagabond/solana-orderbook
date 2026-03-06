import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { SolanaOrderbook } from "../target/types/solana_orderbook";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { assert } from "chai";

describe("solana-orderbook", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.solanaOrderbook as Program<SolanaOrderbook>;
  const connection = provider.connection;

  // Keypairs
  const authority = Keypair.generate();
  const bidder = Keypair.generate();
  const asker = Keypair.generate();
  const takerUser = Keypair.generate();

  // Mints
  let baseMint: PublicKey;
  let quoteMint: PublicKey;

  // Market PDA
  let marketPda: PublicKey;
  let marketBump: number;

  // Vaults (raw token accounts owned by the market PDA)
  let baseVault: PublicKey;
  let quoteVault: PublicKey;

  // Token accounts
  let bidderQuoteAta: PublicKey;
  let bidderBaseAta: PublicKey;
  let askerBaseAta: PublicKey;
  let askerQuoteAta: PublicKey;
  let takerBaseAta: PublicKey;
  let takerQuoteAta: PublicKey;

  const decimals = 6;
  const price = new BN(10); // 10 quote per base
  const quantity = new BN(100); // 100 base tokens

  before(async () => {
    // Airdrop SOL
    const airdropAmount = 10 * LAMPORTS_PER_SOL;
    const sigs = await Promise.all([
      connection.requestAirdrop(authority.publicKey, airdropAmount),
      connection.requestAirdrop(bidder.publicKey, airdropAmount),
      connection.requestAirdrop(asker.publicKey, airdropAmount),
      connection.requestAirdrop(takerUser.publicKey, airdropAmount),
    ]);
    await Promise.all(
      sigs.map((sig) => connection.confirmTransaction(sig, "confirmed"))
    );

    // Create mints
    baseMint = await createMint(
      connection,
      authority,
      authority.publicKey,
      null,
      decimals
    );
    quoteMint = await createMint(
      connection,
      authority,
      authority.publicKey,
      null,
      decimals
    );

    // Derive market PDA
    [marketPda, marketBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("market"),
        authority.publicKey.toBuffer(),
        baseMint.toBuffer(),
        quoteMint.toBuffer(),
      ],
      program.programId
    );

    // Create vault token accounts owned by the market PDA
    baseVault = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        baseMint,
        marketPda,
        true // allowOwnerOffCurve — PDA owner
      )
    ).address;

    quoteVault = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        quoteMint,
        marketPda,
        true
      )
    ).address;

    // Create user token accounts and mint tokens
    // Bidder needs quote tokens (to place bid orders)
    bidderQuoteAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        bidder,
        quoteMint,
        bidder.publicKey
      )
    ).address;
    await mintTo(
      connection,
      authority,
      quoteMint,
      bidderQuoteAta,
      authority,
      1_000_000
    );

    bidderBaseAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        bidder,
        baseMint,
        bidder.publicKey
      )
    ).address;

    // Asker needs base tokens (to place ask orders)
    askerBaseAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        asker,
        baseMint,
        asker.publicKey
      )
    ).address;
    await mintTo(
      connection,
      authority,
      baseMint,
      askerBaseAta,
      authority,
      1_000_000
    );

    askerQuoteAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        asker,
        quoteMint,
        asker.publicKey
      )
    ).address;

    // Taker needs both base and quote tokens
    takerBaseAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        takerUser,
        baseMint,
        takerUser.publicKey
      )
    ).address;
    await mintTo(
      connection,
      authority,
      baseMint,
      takerBaseAta,
      authority,
      1_000_000
    );

    takerQuoteAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        takerUser,
        quoteMint,
        takerUser.publicKey
      )
    ).address;
    await mintTo(
      connection,
      authority,
      quoteMint,
      takerQuoteAta,
      authority,
      1_000_000
    );
  });

  // ---------------------------------------------------------------------------
  // Helper to derive order PDA for a given order count index
  // ---------------------------------------------------------------------------
  function deriveOrderPda(orderIndex: number): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("order"),
        marketPda.toBuffer(),
        new BN(orderIndex).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
  }

  // -------------------------------------------------------------------------
  // initialize_market
  // -------------------------------------------------------------------------
  it("initializes a market with base and quote mints", async () => {
    await program.methods
      .initializeMarket()
      .accounts({
        authority: authority.publicKey,
        baseMint,
        quoteMint,
        market: marketPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const market = await program.account.market.fetch(marketPda);
    assert.ok(market.authority.equals(authority.publicKey));
    assert.ok(market.baseMint.equals(baseMint));
    assert.ok(market.quoteMint.equals(quoteMint));
    assert.ok(market.orderCount.eq(new BN(0)));
  });

  // -------------------------------------------------------------------------
  // place_order — bid order
  // -------------------------------------------------------------------------
  it("places a bid order and deposits quote tokens to vault", async () => {
    const [orderPda] = deriveOrderPda(0);
    const deposit = price.mul(quantity); // bid deposits price * quantity of quote tokens

    const bidderQuoteBefore = (await getAccount(connection, bidderQuoteAta))
      .amount;

    await program.methods
      .placeOrder({ bid: {} }, price, quantity)
      .accounts({
        owner: bidder.publicKey,
        market: marketPda,
        order: orderPda,
        userTokenAccount: bidderQuoteAta,
        vault: quoteVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([bidder])
      .rpc();

    // Verify order data
    const order = await program.account.order.fetch(orderPda);
    assert.ok(order.market.equals(marketPda));
    assert.ok(order.owner.equals(bidder.publicKey));
    assert.ok(order.id.eq(new BN(0)));
    assert.deepEqual(order.side, { bid: {} });
    assert.ok(order.price.eq(price));
    assert.ok(order.quantity.eq(quantity));
    assert.ok(order.filled.eq(new BN(0)));

    // Verify market order count incremented
    const market = await program.account.market.fetch(marketPda);
    assert.ok(market.orderCount.eq(new BN(1)));

    // Verify quote tokens transferred to vault
    const bidderQuoteAfter = (await getAccount(connection, bidderQuoteAta))
      .amount;
    assert.equal(
      bidderQuoteBefore - bidderQuoteAfter,
      BigInt(deposit.toNumber())
    );

    const vaultBalance = (await getAccount(connection, quoteVault)).amount;
    assert.equal(vaultBalance, BigInt(deposit.toNumber()));
  });

  // -------------------------------------------------------------------------
  // place_order — ask order
  // -------------------------------------------------------------------------
  it("places an ask order and deposits base tokens to vault", async () => {
    const [orderPda] = deriveOrderPda(1);
    const askQuantity = new BN(50);

    const askerBaseBefore = (await getAccount(connection, askerBaseAta)).amount;

    await program.methods
      .placeOrder({ ask: {} }, price, askQuantity)
      .accounts({
        owner: asker.publicKey,
        market: marketPda,
        order: orderPda,
        userTokenAccount: askerBaseAta,
        vault: baseVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([asker])
      .rpc();

    // Verify order data
    const order = await program.account.order.fetch(orderPda);
    assert.ok(order.owner.equals(asker.publicKey));
    assert.deepEqual(order.side, { ask: {} });
    assert.ok(order.quantity.eq(askQuantity));

    // Verify base tokens transferred to vault (ask deposits quantity of base)
    const askerBaseAfter = (await getAccount(connection, askerBaseAta)).amount;
    assert.equal(
      askerBaseBefore - askerBaseAfter,
      BigInt(askQuantity.toNumber())
    );
  });

  // -------------------------------------------------------------------------
  // Error: place_order with zero price should fail
  // -------------------------------------------------------------------------
  it("fails to place order with zero price", async () => {
    const [orderPda] = deriveOrderPda(2);
    try {
      await program.methods
        .placeOrder({ bid: {} }, new BN(0), quantity)
        .accounts({
          owner: bidder.publicKey,
          market: marketPda,
          order: orderPda,
          userTokenAccount: bidderQuoteAta,
          vault: quoteVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([bidder])
        .rpc();
      assert.fail("Expected InvalidOrder error");
    } catch (err: any) {
      assert.include(err.toString(), "InvalidOrder");
    }
  });

  // -------------------------------------------------------------------------
  // Error: place_order with zero quantity should fail
  // -------------------------------------------------------------------------
  it("fails to place order with zero quantity", async () => {
    const [orderPda] = deriveOrderPda(2);
    try {
      await program.methods
        .placeOrder({ ask: {} }, price, new BN(0))
        .accounts({
          owner: asker.publicKey,
          market: marketPda,
          order: orderPda,
          userTokenAccount: askerBaseAta,
          vault: baseVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([asker])
        .rpc();
      assert.fail("Expected InvalidOrder error");
    } catch (err: any) {
      assert.include(err.toString(), "InvalidOrder");
    }
  });

  // -------------------------------------------------------------------------
  // fill_order — partial fill on bid order
  // -------------------------------------------------------------------------
  it("partially fills a bid order", async () => {
    const [orderPda] = deriveOrderPda(0); // bid order from earlier
    const fillQty = new BN(30);
    const quoteAmount = price.mul(fillQty); // quote released to taker

    const takerBaseBefore = (await getAccount(connection, takerBaseAta)).amount;
    const takerQuoteBefore = (await getAccount(connection, takerQuoteAta))
      .amount;

    await program.methods
      .fillOrder(fillQty)
      .accounts({
        taker: takerUser.publicKey,
        market: marketPda,
        order: orderPda,
        vault: quoteVault,
        takerBase: takerBaseAta,
        takerQuote: takerQuoteAta,
        makerBase: bidderBaseAta,
        makerQuote: bidderQuoteAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([takerUser])
      .rpc();

    // Verify order filled amount
    const order = await program.account.order.fetch(orderPda);
    assert.ok(order.filled.eq(fillQty));

    // Taker sent base tokens to maker
    const takerBaseAfter = (await getAccount(connection, takerBaseAta)).amount;
    assert.equal(
      takerBaseBefore - takerBaseAfter,
      BigInt(fillQty.toNumber())
    );

    // Taker received quote tokens from vault
    const takerQuoteAfter = (await getAccount(connection, takerQuoteAta))
      .amount;
    assert.equal(
      takerQuoteAfter - takerQuoteBefore,
      BigInt(quoteAmount.toNumber())
    );
  });

  // -------------------------------------------------------------------------
  // fill_order — full fill on remaining bid order
  // -------------------------------------------------------------------------
  it("fully fills the remaining bid order", async () => {
    const [orderPda] = deriveOrderPda(0);
    const orderBefore = await program.account.order.fetch(orderPda);
    const remaining = orderBefore.quantity.sub(orderBefore.filled);

    await program.methods
      .fillOrder(remaining)
      .accounts({
        taker: takerUser.publicKey,
        market: marketPda,
        order: orderPda,
        vault: quoteVault,
        takerBase: takerBaseAta,
        takerQuote: takerQuoteAta,
        makerBase: bidderBaseAta,
        makerQuote: bidderQuoteAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([takerUser])
      .rpc();

    const order = await program.account.order.fetch(orderPda);
    assert.ok(order.filled.eq(order.quantity));
  });

  // -------------------------------------------------------------------------
  // Error: fill already-fully-filled order should fail
  // -------------------------------------------------------------------------
  it("fails to fill an already fully filled order", async () => {
    const [orderPda] = deriveOrderPda(0);
    try {
      await program.methods
        .fillOrder(new BN(1))
        .accounts({
          taker: takerUser.publicKey,
          market: marketPda,
          order: orderPda,
          vault: quoteVault,
          takerBase: takerBaseAta,
          takerQuote: takerQuoteAta,
          makerBase: bidderBaseAta,
          makerQuote: bidderQuoteAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([takerUser])
        .rpc();
      assert.fail("Expected InvalidFill error");
    } catch (err: any) {
      assert.include(err.toString(), "InvalidFill");
    }
  });

  // -------------------------------------------------------------------------
  // cancel_order — refund correct amount for ask order
  // -------------------------------------------------------------------------
  it("cancels an ask order and refunds base tokens", async () => {
    const [orderPda] = deriveOrderPda(1); // ask order
    const orderBefore = await program.account.order.fetch(orderPda);
    const remaining = orderBefore.quantity.sub(orderBefore.filled);

    const askerBaseBefore = (await getAccount(connection, askerBaseAta)).amount;

    await program.methods
      .cancelOrder()
      .accounts({
        owner: asker.publicKey,
        market: marketPda,
        order: orderPda,
        vault: baseVault,
        ownerTokenAccount: askerBaseAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([asker])
      .rpc();

    // Verify refund
    const askerBaseAfter = (await getAccount(connection, askerBaseAta)).amount;
    assert.equal(
      askerBaseAfter - askerBaseBefore,
      BigInt(remaining.toNumber())
    );

    // Verify order account is closed
    const orderInfo = await connection.getAccountInfo(orderPda);
    assert.isNull(orderInfo);
  });

  // -------------------------------------------------------------------------
  // Error: cancel already-filled order should fail (AlreadyFilled)
  // -------------------------------------------------------------------------
  it("fails to cancel a fully filled order", async () => {
    // Order 0 was fully filled above
    const [orderPda] = deriveOrderPda(0);
    try {
      await program.methods
        .cancelOrder()
        .accounts({
          owner: bidder.publicKey,
          market: marketPda,
          order: orderPda,
          vault: quoteVault,
          ownerTokenAccount: bidderQuoteAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([bidder])
        .rpc();
      assert.fail("Expected AlreadyFilled error");
    } catch (err: any) {
      assert.include(err.toString(), "AlreadyFilled");
    }
  });
});
